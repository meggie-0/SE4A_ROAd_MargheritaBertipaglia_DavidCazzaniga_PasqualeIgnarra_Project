import { userProfileSchema, type UserProfile } from '@road/shared';

/**
 * La sessione dell'operatore: l'access token di M1b e il profilo di chi lo porta.
 *
 * Stessa forma e stesse ragioni di quella dell'app passeggero, con una chiave di deposito diversa:
 * i due client possono girare sullo stesso browser — in sviluppo girano sicuramente, su due porte
 * dello stesso `localhost`, che per il deposito è la stessa origine solo se le porte coincidono —
 * e una chiave condivisa farebbe entrare l'operatore con il token del passeggero.
 *
 * Il codice è duplicato fra i due client di proposito, e vale la pena dirlo: metterlo in comune
 * significherebbe o un import fra `apps/*` — vietato dalla Regola 1 — o portare React e
 * `localStorage` dentro `packages/shared`, che è compilato anche dentro il backend. Trenta righe
 * ripetute costano meno di entrambe le cose.
 */

const STORAGE_KEY = 'road.operator.session';

export interface Session {
  readonly accessToken: string;
  readonly user: UserProfile;
}

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
