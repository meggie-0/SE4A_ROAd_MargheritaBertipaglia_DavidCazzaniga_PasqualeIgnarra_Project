import type { UserRole } from '@road/shared';

/**
 * La porta dell'`AuthenticationManager` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le tre operazioni sono quelle del DD §2.2 — `register`, `authenticate`, `updateProfile` — e
 * nient'altro. Chi ha bisogno di *verificare* un token non passa di qui: quella è una
 * responsabilità del cammino HTTP, e vive nei guard che `access-control.port.ts` pubblica.
 *
 * `auth` espone due porte, come `fleet` e `platform` (HARNESS.md §3):
 *
 * - questo file è il **servizio**: creare un account, autenticarsi, aggiornare il profilo;
 * - `access-control.port.ts` è il **meccanismo** con cui il modulo `gateway` protegge le rotte.
 *
 * Nulla di ciò che esce da questa porta contiene la password, in chiaro o in hash: `AccountProfile`
 * elenca i campi ammessi invece di togliere quelli vietati, così una colonna nuova su `user` non ci
 * finisce dentro per distrazione.
 */

export type { AccessTokenPayload, AuthenticatedUser } from './authenticated-user';

/** Il profilo di un utente come lo vede chi sta fuori dal modulo. **Senza password.** */
export interface AccountProfile {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly surname: string;
  readonly phoneNumber: string | null;
  readonly role: UserRole;
  readonly createdAt: Date;
}

/**
 * Un access token emesso, con la sua durata.
 *
 * Uno solo, senza refresh token (MILESTONES.md §M1b): con un refresh token servirebbe un registro
 * dei token revocati, cioè esattamente lo stato di sessione lato server che NFR3 esclude.
 */
export interface IssuedToken {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
}

/** L'esito di `register` e di `authenticate`: chi sei, e con che cosa lo dimostri. */
export interface AuthResult {
  readonly user: AccountProfile;
  readonly token: IssuedToken;
}

/**
 * L'input di `register`.
 *
 * `role` è un parametro della **porta**, non del contratto HTTP: `POST /auth/register` crea sempre
 * un `PASSENGER`, perché il RASD §1.4 prevede «Passenger registration» ma non la registrazione di
 * un operatore. Gli account operatore li crea chi amministra il sistema — in questo prototipo il
 * seed — e passa da qui invece di scrivere una riga a mano, così l'hash della password lo produce
 * sempre lo stesso codice.
 */
export interface RegisterInput {
  readonly email: string;
  readonly password: string;
  readonly name: string;
  readonly surname: string;
  readonly phoneNumber: string | null;
  readonly role: UserRole;
}

/** L'input di `authenticate`. Vale per entrambi i ruoli (R1). */
export interface Credentials {
  readonly email: string;
  readonly password: string;
}

/**
 * L'input di `updateProfile` (R2: «personal information **and credentials**»).
 *
 * Un campo assente resta com'è; `phoneNumber: null` lo cancella. La distinzione fra «non indicato»
 * e «indicato nullo» è il motivo per cui questo tipo non è un `Partial<AccountProfile>`.
 */
export interface ProfileUpdate {
  readonly email?: string;
  readonly password?: string;
  readonly name?: string;
  readonly surname?: string;
  readonly phoneNumber?: string | null;
}

export abstract class AuthPort {
  /**
   * Crea un account e lo autentica subito, restituendo il primo token.
   *
   * Solleva `EmailAlreadyRegisteredError` se l'indirizzo è già in uso. Il rifiuto arriva dal
   * vincolo di unicità del database e non da una lettura precedente: fra una `SELECT` che non
   * trova nulla e la `INSERT` che segue ci sta un'altra registrazione con lo stesso indirizzo, e
   * su due repliche del tier applicativo (NFR3) quella finestra è reale.
   */
  abstract register(input: RegisterInput): Promise<AuthResult>;

  /**
   * Verifica le credenziali ed emette un token.
   *
   * Solleva `InvalidCredentialsError` **sia** quando l'indirizzo non esiste **sia** quando la
   * password è sbagliata, con lo stesso messaggio: due errori distinti direbbero a chiunque quali
   * indirizzi sono registrati.
   */
  abstract authenticate(credentials: Credentials): Promise<AuthResult>;

  /**
   * Aggiorna i campi indicati del profilo e restituisce il profilo aggiornato.
   *
   * Non emette un token nuovo: il token porta `sub` e `role`, e nessuno dei due è aggiornabile da
   * qui, quindi quello in mano al chiamante resta valido e corretto fino alla scadenza.
   *
   * Solleva `UnknownUserError` se l'utente non esiste — il caso di un token ancora valido il cui
   * account è stato rimosso — e `EmailAlreadyRegisteredError` se il nuovo indirizzo è già di un
   * altro.
   */
  abstract updateProfile(userId: string, patch: ProfileUpdate): Promise<AccountProfile>;
}

/** Sollevata quando l'indirizzo è già associato a un altro account. */
export class EmailAlreadyRegisteredError extends Error {
  constructor(readonly email: string) {
    super(`L'indirizzo ${email} è già registrato.`);
    this.name = 'EmailAlreadyRegisteredError';
  }
}

/**
 * Sollevata quando le credenziali non sono valide.
 *
 * Non porta l'indirizzo e non dice *quale* delle due parti è sbagliata: è la stessa risposta per
 * un account inesistente e per una password errata, che è ciò che impedisce di usare il login come
 * oracolo per scoprire chi è iscritto.
 */
export class InvalidCredentialsError extends Error {
  constructor() {
    super('Credenziali non valide.');
    this.name = 'InvalidCredentialsError';
  }
}

/** Sollevata quando l'identificatore non corrisponde ad alcun utente. */
export class UnknownUserError extends Error {
  constructor(readonly userId: string) {
    super(`Nessun utente con id ${userId}.`);
    this.name = 'UnknownUserError';
  }
}
