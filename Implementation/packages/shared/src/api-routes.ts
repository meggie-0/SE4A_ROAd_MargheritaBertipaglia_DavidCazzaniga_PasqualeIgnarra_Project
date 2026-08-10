/**
 * Le rotte pubblicate dall'API Gateway, in un posto solo.
 *
 * I client non importano nulla da `apps/api` (CLAUDE.md Regola 1): conoscono il backend solo
 * attraverso `contracts/openapi.json` e queste costanti.
 */
export const API_ROUTES = {
  health: '/health',
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];
