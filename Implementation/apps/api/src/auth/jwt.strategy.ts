import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { USER_ROLES } from '@road/shared';
import { ExtractJwt, Strategy, type StrategyOptionsWithoutRequest } from 'passport-jwt';
import { z } from 'zod';

import { AccountLookup } from './account-lookup';
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
 * **Non consulta alcun registro di sessione**, ed è la proposizione che il DD §4.3 usa per NFR3: un
 * token emesso da un'istanza è accettato da una seconda che non ha mai visto quel login, perché
 * tutto ciò che serve per accettarlo sta nel token, nella chiave di firma e nel livello dati che le
 * repliche condividono.
 *
 * Fino a **D78** questo commento diceva «non tocca il database», e non era il requisito: era un
 * vincolo più severo, che nessun documento chiedeva e che costava un difetto. Un token il cui
 * soggetto non esiste più passava di qui e arrivava fino al database, dove diventava una violazione
 * di chiave esterna e un `500` — «Internal server error» davanti a un utente la cui unica colpa era
 * non aver rifatto l'accesso dopo un `db:seed`. `AccountLookup` chiude quel varco con una lettura
 * che ogni replica può fare, e che non le rende meno intercambiabili di prima.
 *
 * La scadenza la verifica `passport-jwt` (`ignoreExpiration: false`) confrontando `exp` con
 * l'orologio di sistema, dentro la libreria. Non è una violazione della Regola 3: il tempo del
 * token è misurato dalla stessa libreria che lo scrive e che lo rilegge, e imporle `ClockPort`
 * significherebbe emettere token che il verificatore — che non controlliamo — considera scaduti.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, JWT_STRATEGY_NAME) {
  constructor(
    config: ConfigService,
    private readonly accounts: AccountLookup,
  ) {
    const options: StrategyOptionsWithoutRequest = {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: readJwtSecret(config),
    };
    super(options);
  }

  async validate(payload: unknown): Promise<AuthenticatedUser> {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) throw new UnauthorizedException('Token non conforme.');

    // Stesso codice e stesso messaggio di un token illeggibile. Distinguere «il tuo account non
    // c'è più» da «il tuo token non vale» direbbe a chiunque abbia un token firmato quali
    // identificatori esistono nel database, ed è la stessa ragione per cui il login risponde allo
    // stesso modo a un indirizzo sconosciuto e a una password sbagliata (`auth.manager.ts`).
    if (!(await this.accounts.exists(parsed.data.sub))) {
      throw new UnauthorizedException('Token non conforme.');
    }

    return { id: parsed.data.sub, email: parsed.data.email, role: parsed.data.role };
  }
}
