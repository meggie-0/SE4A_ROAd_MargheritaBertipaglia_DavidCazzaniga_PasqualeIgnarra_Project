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

import type { AuthenticatedUser } from './authenticated-user';

export type { AccessTokenPayload, AuthenticatedUser } from './authenticated-user';
export { CurrentUser } from './current-user.decorator';
export { JwtAuthGuard } from './jwt-auth.guard';
export { ROLES_METADATA_KEY, Roles } from './roles.decorator';
export { RolesGuard } from './roles.guard';

/**
 * La verifica di un token **fuori dal cammino HTTP** (M5).
 *
 * I guard qui sopra coprono le rotte, e coprono tutto finché ciò che si protegge è una richiesta:
 * Passport legge `Authorization` e `JwtStrategy` fa il resto. Il canale push di M5 non passa di lì —
 * aprendo una WebSocket il browser non può impostare quell'header, quindi il token viaggia nel
 * campo `auth` dell'handshake di Socket.IO — e senza questa porta il `gateway` dovrebbe verificarlo
 * da sé, conoscendo la chiave di firma e il formato del payload di un altro modulo.
 *
 * È l'unica classe di questo file che compare negli `exports` di `AuthModule`, e ci compare perché
 * dev'essere **iniettata**: i guard no, quelli Nest li istanzia nel modulo che dichiara il
 * controller. Il nome finisce in `Port` come la Regola 1 impone a tutto ciò che un modulo esporta.
 */
export abstract class TokenVerifierPort {
  /** Chi porta il token, o `null` se è scaduto, falso o malformato. Non solleva. */
  abstract verify(accessToken: string): Promise<AuthenticatedUser | null>;
}
