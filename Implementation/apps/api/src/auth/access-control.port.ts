/**
 * La seconda porta di `auth`: il **meccanismo** con cui il modulo `gateway` protegge le rotte
 * (CLAUDE.md Regola 1, HARNESS.md §3 — «tutti i `*.port.ts` alla radice del modulo»).
 *
 * `auth.port.ts` è il servizio: registrarsi, autenticarsi, aggiornare il profilo. Questo file è ciò
 * che serve a chi pubblica HTTP per *far valere* quell'autenticazione, e sta in `auth` perché la
 * verifica del token e la conoscenza dei ruoli sono affari suoi: il `gateway` li **applica**
 * (MILESTONES.md §M1b), non li implementa.
 *
 * La divisione è la stessa di `fleet` (`fleet-monitor.port.ts` il servizio, `robotaxi.port.ts` il
 * vocabolario) e di `platform` (`clock.port.ts`, `random.port.ts`).
 *
 * Le tre classi qui esportate **non** compaiono negli `exports` di `AuthModule`, e non è una
 * dimenticanza: `@UseGuards(JwtAuthGuard, RolesGuard)` le referenzia per classe, e Nest le istanzia
 * nel contesto del modulo che dichiara il controller. Negli `exports` di un `@Module` possono
 * comparire solo classi il cui nome finisce in `Port` (CLAUDE.md Regola 1), verificato da
 * `test/arch/exports.spec.ts`.
 */

export type { AccessTokenPayload, AuthenticatedUser } from './authenticated-user';
export { CurrentUser } from './current-user.decorator';
export { JwtAuthGuard } from './jwt-auth.guard';
export { ROLES_METADATA_KEY, Roles } from './roles.decorator';
export { RolesGuard } from './roles.guard';
