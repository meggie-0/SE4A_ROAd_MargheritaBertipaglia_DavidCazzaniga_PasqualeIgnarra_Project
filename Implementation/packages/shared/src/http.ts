import type { z } from 'zod';

/**
 * Il minimo di client HTTP che i due client di M8 condividono.
 *
 * Sta in `packages/shared` per la stessa ragione di `fetchHealth()`, che è il suo precedente: la
 * dashboard e l'app passeggero parlano **solo** l'HTTP pubblico e i tipi di questo pacchetto
 * (CLAUDE.md Regola 1), e senza un punto comune ognuna reinventerebbe la stessa `fetch` con la
 * stessa intestazione `Authorization` e la stessa gestione degli errori — due copie che divergono
 * alla prima che qualcuno tocca.
 *
 * **Non è un SDK del backend e non deve diventarlo.** Non conosce nessuna rotta: le rotte stanno in
 * `api-routes.ts` e le forme in `auth.ts`, `rides.ts`, `mode.ts`, `fleet.ts`. Qui c'è solo il
 * trasporto — costruisci l'indirizzo, manda, controlla lo stato, valida ciò che è tornato con lo
 * schema che il chiamante passa. Chi riscrivesse un client in un altro framework può ignorare
 * questo file e leggere `contracts/openapi.json`, che resta la fonte del contratto (HARNESS.md §4).
 *
 * **La validazione non è decorativa.** Una risposta che non rispetta lo schema condiviso è un
 * disallineamento fra backend e client, ed è meglio che si veda subito come errore che tre schermate
 * più in là come `undefined`.
 */

/** Il minimo di `fetch` che serve, così il pacchetto non dipende dai tipi del DOM. */
export type HttpFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

/**
 * Un errore dell'API, con lo stato HTTP che l'ha provocato.
 *
 * Lo stato serve ai client per distinguere i casi che l'interfaccia tratta diversamente: `401`
 * significa «la sessione è scaduta, torna al login», `403` «questo non è il tuo ruolo», `409` «lo
 * stato del sistema è cambiato sotto di te». Un errore senza stato costringerebbe a leggere il
 * messaggio, che è testo per un umano e non un dato.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}

/** Errore di rete o di contratto: la richiesta non è arrivata, o è tornata in una forma ignota. */
export class ApiTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApiTransportError';
  }
}

/**
 * Se valga la pena **riprovare** una richiesta fallita.
 *
 * Serve alla politica di ripetizione dei due client, e sta qui perché la decisione dipende da
 * `ApiError`, che è di questo file: un client che la scrivesse da sé dovrebbe conoscere gli stessi
 * codici, e i due divergerebbero.
 *
 * La regola è una sola: **una risposta di errore fra 400 e 499 non si riprova.** Il server non ha
 * avuto un intoppo, ha rifiutato la richiesta nel merito — un token scaduto resta scaduto, un corpo
 * malformato resta malformato — e ritentare produce identicamente la stessa risposta un istante
 * dopo. Tutto il resto sì: un guasto del server e un errore di trasporto sono per loro natura
 * transitori.
 *
 * **Non è un dettaglio di prestazioni.** `@tanstack/react-query` tiene una query che sta aspettando
 * di ritentare in stato `pending`, non `error`, e mette in pausa i tentativi quando il documento non
 * è visibile: una lettura periodica che riceve 401 su una scheda in secondo piano resterebbe
 * `pending` **per sempre**, con `error` a `null`. Chi osserva l'errore per riportare al login non
 * verrebbe mai svegliato, e la dashboard resterebbe a mostrare l'ultima lettura riuscita. Con questa
 * regola il 401 non ha alcun tentativo da attendere e la query si posa subito su `error`.
 */
export function isRetriableFailure(error: unknown): boolean {
  if (error instanceof ApiError) return error.status < 400 || error.status >= 500;
  return true;
}

export interface ApiRequestOptions<T> {
  /** Lo schema con cui validare la risposta. È obbligatorio: vedi il commento in testa al file. */
  readonly schema: z.ZodType<T>;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  readonly body?: unknown;
  /** L'access token di M1b, se la rotta lo richiede. */
  readonly token?: string | null;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: HttpFetch;
}

/**
 * Una richiesta all'API, validata.
 *
 * Solleva `ApiError` se il backend ha risposto con uno stato di errore e `ApiTransportError` se la
 * richiesta non è partita o la risposta non è conforme allo schema.
 */
export async function apiRequest<T>(
  baseUrl: string,
  path: string,
  options: ApiRequestOptions<T>,
): Promise<T> {
  const url = `${baseUrl.replace(/\/+$/, '')}${path}`;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as HttpFetch);

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token !== undefined && options.token !== null) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let response: Awaited<ReturnType<HttpFetch>>;
  try {
    response = await fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    throw new ApiTransportError(`Impossibile contattare l'API su ${url}.`, { cause: error });
  }

  if (!response.ok) {
    throw new ApiError(await errorMessageOf(response), response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ApiTransportError(`Risposta di ${url} non è JSON.`, { cause: error });
  }

  const parsed = options.schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiTransportError(`Risposta di ${url} non conforme al contratto condiviso.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Il messaggio d'errore del backend, o un ripiego leggibile.
 *
 * Nest risponde agli errori con `{ statusCode, message, error }`, dove `message` può essere una
 * stringa o un elenco (la validazione ne produce uno per campo). Si prende quello, perché è scritto
 * per essere mostrato; se manca o il corpo non è JSON si ripiega sullo stato, che c'è sempre.
 */
async function errorMessageOf(response: Awaited<ReturnType<HttpFetch>>): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === 'object' && body !== null && 'message' in body) {
      const message: unknown = (body as { message: unknown }).message;
      if (typeof message === 'string' && message.length > 0) return message;
      if (Array.isArray(message) && message.length > 0) return message.join('; ');
    }
  } catch {
    // Corpo assente o non JSON: sotto c'è comunque lo stato, che è l'informazione minima.
  }
  return `L'API ha risposto ${response.status}.`;
}
