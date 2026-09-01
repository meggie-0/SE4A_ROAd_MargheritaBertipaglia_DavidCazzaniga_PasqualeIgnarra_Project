import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { USER_ROLES } from '@road/shared';

import type { AccessTokenPayload, AuthenticatedUser } from './authenticated-user';
import { AccountLookup } from './account-lookup';
import { TokenVerifierPort } from './access-control.port';

/**
 * Verifica un access token **fuori dal cammino HTTP**.
 *
 * I guard di M1b bastano finché si protegge una rotta: Passport legge l'header `Authorization`
 * dalla richiesta e `JwtStrategy` fa il resto. Un handshake WebSocket non è una richiesta HTTP con
 * quell'header — il browser non permette di impostarlo aprendo una socket — quindi il token arriva
 * in `handshake.auth`, e serve un modo di verificarlo che non presupponga il ciclo di vita di una
 * richiesta.
 *
 * La verifica resta comunque **dentro `auth`**, che è il punto: il `gateway` applica
 * l'autenticazione, non la implementa (MILESTONES.md §M1b). Se questa classe stesse là, il modulo
 * `gateway` dovrebbe conoscere la chiave di firma e il formato del payload, cioè due segreti del
 * modulo accanto.
 *
 * Riusa lo stesso `JwtService` di `TokenIssuer`, configurato da `AuthModule` con la chiave letta a
 * runtime: firma e verifica non possono divergere perché sono lo stesso oggetto.
 */
@Injectable()
export class TokenVerifier extends TokenVerifierPort {
  constructor(
    private readonly jwt: JwtService,
    private readonly accounts: AccountLookup,
  ) {
    super();
  }

  /**
   * Restituisce chi porta il token, o `null` se non è valido.
   *
   * `null` e non un'eccezione: un handshake con un token scaduto o falso è un esito ordinario del
   * canale — succede a ogni token che scade mentre l'app è aperta — e chi chiama deve chiudere la
   * connessione, non gestire un guasto. È la stessa scelta fatta per il rifiuto di una corsa.
   *
   * Il payload viene **ricontrollato** dopo la verifica della firma. Un token firmato con la
   * nostra chiave ma con un `role` che non è dei nostri non deve produrre un utente a metà: la
   * firma dice che il token è nostro, non che il contenuto è quello che ci aspettiamo.
   *
   * L'ultimo controllo è che l'account esista ancora (D78), **lo stesso che fa `JwtStrategy`** e per
   * mezzo della stessa classe. Le due porte d'ingresso devono rispondere allo stesso modo: una
   * socket che resta aperta con un token che le rotte rifiutano continuerebbe a spedire eventi a chi
   * non può più leggerli.
   */
  async verify(accessToken: string): Promise<AuthenticatedUser | null> {
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(accessToken);
    } catch {
      return null;
    }

    if (typeof payload.sub !== 'string' || payload.sub === '') return null;
    if (typeof payload.email !== 'string') return null;
    if (!USER_ROLES.includes(payload.role)) return null;
    if (!(await this.accounts.exists(payload.sub))) return null;

    return { id: payload.sub, email: payload.email, role: payload.role };
  }
}
