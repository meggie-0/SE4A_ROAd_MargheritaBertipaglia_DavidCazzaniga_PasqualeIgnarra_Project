/**
 * Le rotte pubblicate dall'API Gateway, in un posto solo.
 *
 * I client non importano nulla da `apps/api` (CLAUDE.md Regola 1): conoscono il backend solo
 * attraverso `contracts/openapi.json` e queste costanti.
 */
export const API_ROUTES = {
  health: '/health',

  // Autenticazione (M1b, RASD R1 e R2). `authProfile` serve sia in lettura sia in aggiornamento:
  // è la stessa risorsa — il profilo di chi porta il token — e distinguerla per verbo è ciò che
  // rende `GET` e `PATCH` due operazioni sulla stessa cosa invece di due rotte da tenere allineate.
  authRegister: '/auth/register',
  authLogin: '/auth/login',
  authProfile: '/auth/me',

  // Strategia di allocazione (M3, RASD R8 e G5). Una risorsa sola, letta e scritta: `GET` la
  // mostra sulla dashboard, `PUT` la cambia a sistema acceso. È riservata all'operatore, e il
  // vincolo di ruolo lo fanno valere i guard di M1b.
  allocationStrategy: '/allocation/strategy',

  // Richieste di corsa (M4, RASD R3, R4 e R14). Due rotte di creazione e non una con un campo
  // discriminante: immediata e anticipata hanno corpi diversi — solo la seconda porta l'orario —
  // e due schemi distinti sono ciò che permette al compilatore e all'OpenAPI di dire quale campo
  // è obbligatorio dove. L'annullamento è una `POST` su una sotto-risorsa e non una `DELETE`:
  // non cancella nulla, cambia lo stato della richiesta in `CANCELLED` e la lascia nello storico.
  ridesImmediate: '/rides/immediate',
  ridesAdvance: '/rides/advance',
  rideCancel: '/rides/:rideRequestId/cancel',
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];

/**
 * L'indirizzo di annullamento di una richiesta concreta.
 *
 * `API_ROUTES.rideCancel` porta il segnaposto nella forma che Nest si aspetta nel decoratore; un
 * client deve sostituirlo. Farlo qui, una volta, evita che ogni chiamante reinventi la stessa
 * `replace` — e che qualcuno la sbagli scrivendo l'indirizzo a mano.
 */
export const rideCancelRoute = (rideRequestId: string): string =>
  API_ROUTES.rideCancel.replace(':rideRequestId', encodeURIComponent(rideRequestId));
