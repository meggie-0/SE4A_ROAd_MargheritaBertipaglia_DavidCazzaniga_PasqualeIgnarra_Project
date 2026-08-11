import type { UserRole } from '@road/shared';

/**
 * Chi sta facendo la richiesta, ricostruito **dal solo token**.
 *
 * È il valore che `JwtStrategy` mette su `request.user` e che `@CurrentUser()` consegna al
 * controller. I tre campi sono esattamente quelli firmati nel token, e non un utente riletto dal
 * database: NFR3 chiede che l'autenticazione non consulti alcun registro, così un token emesso da
 * un'istanza del tier applicativo è accettato da qualunque altra che conosca la stessa chiave di
 * firma, senza che le due debbano condividere niente in memoria.
 *
 * Ciò che *cambia* — il nome, il telefono — non sta qui: chi ne ha bisogno lo legge dal profilo
 * (`GET /auth/me`), che è dato persistito e non dato di sessione. Se il ruolo cambiasse, il token
 * porterebbe il ruolo vecchio fino alla scadenza; è la conseguenza voluta di non avere sessioni, e
 * la scadenza breve è il modo in cui si limita.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

/**
 * Il contenuto del token firmato.
 *
 * `sub` è il campo standard di JWT (RFC 7519 §4.1.2) per il soggetto: usarlo invece di un `id`
 * inventato tiene il token leggibile da qualunque libreria conforme. `iat` ed `exp` non compaiono
 * qui perché li aggiunge e li verifica la libreria (vedi `token-issuer.ts`).
 *
 * **Nessun campo segreto.** Il payload di un JWT è firmato, non cifrato: chiunque abbia il token
 * può leggerlo. Il cancello di M1b lo decodifica e verifica che non contenga né la password né il
 * suo hash.
 */
export interface AccessTokenPayload {
  readonly sub: string;
  readonly email: string;
  readonly role: UserRole;
}
