import { z } from 'zod';

import { API_ROUTES } from './api-routes.js';

/**
 * Schema della risposta di `GET /health`. È la sorgente unica di verità: il DTO del backend la
 * implementa (il compilatore verifica che i due non divergano) e i client la usano per validare
 * ciò che ricevono, come chiede il DD §2.2.1 ("request and response shapes are declared once as
 * schemas shared by backend and clients").
 */
export const healthResponseSchema = z.object({
  /** `ok` quando il servizio è in grado di rispondere. */
  status: z.literal('ok'),
  /** Nome del servizio che risponde, utile quando i client puntano al backend sbagliato. */
  service: z.string().min(1),
  /** Versione dichiarata dal package dell'API. */
  version: z.string().min(1),
  /** Istante della risposta in ISO 8601, letto da `ClockPort` e non dall'orologio di sistema. */
  time: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** Il minimo di `fetch` che ci serve, così `packages/shared` non dipende dai tipi del DOM. */
export type FetchLike = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export class HealthCheckError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HealthCheckError';
  }
}

/**
 * Legge lo stato dell'API dal suo endpoint `/health` e ne valida la forma.
 *
 * Vive in `packages/shared` perché la usano entrambi i client (dashboard operatore e app
 * passeggero) e perché così il cancello di M0 può verificarla contro l'API vera senza che nessuno
 * dei due client debba importare qualcosa dal backend.
 */
export async function fetchHealth(
  baseUrl: string,
  fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
): Promise<HealthResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}${API_ROUTES.health}`;

  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new HealthCheckError(`Impossibile contattare l'API su ${url}`, { cause: error });
  }

  if (!response.ok) {
    throw new HealthCheckError(`L'API ha risposto ${response.status} su ${url}`);
  }

  const payload = await response.json();
  const parsed = healthResponseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new HealthCheckError(`Risposta di ${url} non conforme al contratto`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}
