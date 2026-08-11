import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';

import { PersistenceModule } from '../persistence/persistence.module';

import { AuthManager } from './auth.manager';
import { AuthPort } from './auth.port';
import { readJwtSecret } from './jwt.config';
import { JwtStrategy } from './jwt.strategy';
import { PasswordHasher } from './password-hasher';
import { TokenIssuer } from './token-issuer';

/**
 * Il modulo `auth` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Negli `exports` c'è **solo** `AuthPort`: `AuthManager`, `PasswordHasher`, `TokenIssuer` e
 * `JwtStrategy` restano dentro. I guard e i decoratori che il `gateway` applica alle rotte non
 * sono provider e non passano da qui — li pubblica `access-control.port.ts`, e Nest li istanzia
 * nel contesto del modulo che dichiara il controller.
 *
 * `PlatformModule` non compare fra gli `imports`, a differenza degli altri moduli di dominio: le
 * uniche marche temporali che questo modulo scrive sono `user.createdAt`, che `PersistenceManager`
 * riempie già da `ClockPort`, e la scadenza del token, che appartiene alla libreria (vedi
 * `token-issuer.ts`). Importare `platform` per non usarlo sarebbe un arco di troppo.
 */
@Module({
  imports: [
    ConfigModule,
    PersistenceModule,
    PassportModule,
    // `registerAsync` e non `register`: il segreto va letto a runtime dal `ConfigService`, e con la
    // forma sincrona verrebbe fissato al momento in cui questo file viene importato — cioè prima
    // che `ConfigModule` abbia caricato `.env`.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ secret: readJwtSecret(config) }),
    }),
  ],
  providers: [
    PasswordHasher,
    TokenIssuer,
    JwtStrategy,
    { provide: AuthPort, useClass: AuthManager },
  ],
  exports: [AuthPort], // SOLO la porta
})
export class AuthModule {}
