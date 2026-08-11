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
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
