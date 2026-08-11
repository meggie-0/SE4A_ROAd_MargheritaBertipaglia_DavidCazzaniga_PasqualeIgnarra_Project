import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { USER_ROLES } from '@road/shared';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';
import { z } from 'zod';

import type { AuthenticatedUser } from './authenticated-user';
import { readJwtSecret } from './jwt.config';

/**
 * Il nome con cui la strategia si registra in Passport.
 *
 * È un dettaglio interno al modulo: fuori si usa `JwtAuthGuard`, non `AuthGuard('jwt')`. Se un
 * giorno la verifica passasse a un'altra libreria, il nome sparirebbe senza che `gateway` se ne
 * accorga.
 */
export const JWT_STRATEGY_NAME = 'jwt';

/**
 * La forma attesa del payload firmato.
 *
 * Il controllo può sembrare superfluo — la firma dimostra che il token l'abbiamo emesso noi — ma
 * dimostra solo che *qualcuno con quel segreto* l'ha emesso: un token firmato da una versione
 * precedente del sistema, o dallo stesso segreto riusato per altro, passerebbe la verifica
 * crittografica portando un payload di forma diversa. Qui diventa un 401 invece di un `undefined`
 * che si propaga fino al controller.
 */
const payloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  role: z.enum(USER_ROLES),
});

/**
 * Verifica il token e ricostruisce chi sta chiamando (NFR3).
 *
 * **Non tocca il database e non consulta alcun registro in memoria.** È esattamente la proposizione
 * che il DD §4.3 usa per NFR3: un token emesso da un'istanza è accettato da una seconda che non ha
 * mai visto quel login, perché tutto ciò che serve per accettarlo sta nel token e nella chiave di
 * firma. Aggiungere qui una lettura dell'utente sembrerebbe più prudente e renderebbe falso il
 * requisito.
 *
 * La scadenza la verifica `passport-jwt` (`ignoreExpiration: false`) confrontando `exp` con
 * l'orologio di sistema, dentro la libreria. Non è una violazione della Regola 3: il tempo del
 * token è misurato dalla stessa libreria che lo scrive e che lo rilegge, e imporle `ClockPort`
 * significherebbe emettere token che il verificatore — che non controlliamo — considera scaduti.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, JWT_STRATEGY_NAME) {
  constructor(config: ConfigService) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: readJwtSecret(config),
    };
    super(options);
  }

  validate(payload: unknown): AuthenticatedUser {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) throw new UnauthorizedException('Token non conforme.');

    return { id: parsed.data.sub, email: parsed.data.email, role: parsed.data.role };
  }
}
