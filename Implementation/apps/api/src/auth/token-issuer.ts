import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { AccessTokenPayload, AuthenticatedUser } from './authenticated-user';
import type { IssuedToken } from './auth.port';
import { readTokenLifetimeSeconds } from './jwt.config';

/**
 * Emette l'access token.
 *
 * Il payload contiene **solo** identificatore, indirizzo e ruolo: un JWT è firmato e non cifrato,
 * quindi tutto ciò che ci si mette dentro è leggibile da chiunque abbia il token. Il cancello di
 * M1b lo decodifica e verifica che né la password né il suo hash vi compaiano.
 *
 * `iat` ed `exp` li scrive la libreria, con il proprio orologio. È l'unico punto del backend in cui
 * il tempo non passa da `ClockPort`, e la Regola 3 non è aggirata: chi *verifica* la scadenza è la
 * stessa libreria, con lo stesso orologio, e non lo controlliamo noi. Un token con `exp` calcolato
 * da un `FakeClock` fermo a maggio 2026 verrebbe rifiutato come scaduto da quel verificatore, e i
 * test dimostrerebbero il contrario di ciò che serve. Il tempo del *dominio* — `user.createdAt` —
 * viene da `ClockPort` come ovunque.
 */
@Injectable()
export class TokenIssuer {
  private readonly lifetimeSeconds: number;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    this.lifetimeSeconds = readTokenLifetimeSeconds(config);
  }

  async issue(user: AuthenticatedUser): Promise<IssuedToken> {
    const payload: AccessTokenPayload = { sub: user.id, email: user.email, role: user.role };

    return {
      accessToken: await this.jwt.signAsync(payload, { expiresIn: this.lifetimeSeconds }),
      expiresInSeconds: this.lifetimeSeconds,
    };
  }
}
