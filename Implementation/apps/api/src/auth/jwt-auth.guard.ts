import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

import { JWT_STRATEGY_NAME } from './jwt.strategy';

/**
 * «Serve un token valido»: 401 se manca, è scaduto o la firma non torna.
 *
 * È una sottoclasse di una riga e non l'uso diretto di `AuthGuard('jwt')` nei controller perché
 * quella stringa è il nome con cui la strategia si registra in Passport, cioè un dettaglio interno
 * al modulo `auth`. Scritta nel `gateway` diventerebbe un accordo implicito fra due moduli che i
 * confini della Regola 1 dovrebbero impedire — e nessuno strumento lo segnalerebbe, perché una
 * stringa uguale in due file non è un import.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard(JWT_STRATEGY_NAME) {}
