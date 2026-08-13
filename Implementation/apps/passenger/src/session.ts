import { userProfileSchema, type UserProfile } from '@road/shared';

/**
 * La sessione del passeggero: l'access token di M1b e il profilo di chi lo porta.
 *
 * **Perché sopravvive a un ricaricamento.** NFR6, nella formulazione falsificabile del DD §4.3,
 * chiede che «a passenger completes a ride request from a cold start of the client in at most four
 * interactions». Con la sessione in memoria, ogni avvio a freddo ricomincerebbe da indirizzo e
 * password, e le sole due interazioni del login mangerebbero metà del bilancio prima ancora di
 * vedere la mappa. Conservare il token è quindi parte del requisito, non una comodità.
 *
 * **Cosa questo non è.** Non è stato di sessione lato server: il backend non ne tiene traccia, e
 * NFR3 resta intatto — qui c'è una copia del token nel browser di chi lo possiede, che è dove i
 * token stanno. Alla scadenza il backend risponde `401` e il client torna al login; non c'è refresh
 * token da rinnovare, perché M1b non ne emette.
 */

const STORAGE_KEY = 'road.passenger.session';

export interface Session {
  readonly accessToken: string;
  readonly user: UserProfile;
}

/**
 * La sessione conservata, o `null` se non ce n'è una leggibile.
 *
 * Il profilo si rivalida con lo schema condiviso invece di fidarsi di ciò che c'è nel deposito: è
 * memoria che l'utente può modificare, e un contratto cambiato fra due versioni del client lascia
 * lì dentro una forma vecchia. In entrambi i casi la risposta giusta è la stessa — nessuna
 * sessione, si rifà il login — e non un errore a metà schermata.
 */
export function loadSession(): Session | null {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (raw === null || raw === undefined) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const { accessToken, user } = parsed as { accessToken?: unknown; user?: unknown };
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;

    const profile = userProfileSchema.safeParse(user);
    if (!profile.success) return null;

    return { accessToken, user: profile.data };
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  globalThis.localStorage?.removeItem(STORAGE_KEY);
}
