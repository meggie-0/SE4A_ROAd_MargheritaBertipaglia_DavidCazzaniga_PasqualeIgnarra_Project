import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';

import { AuthController } from './auth.controller';
import { HealthController } from './health.controller';

/**
 * API Gateway (DD §2.2): unico punto d'ingresso dei client.
 *
 * Importa soltanto porte di altri moduli e non espone nulla di proprio: da qui in avanti ogni
 * milestone aggiunge controller che delegano a una porta, mai logica di dominio.
 *
 * `AuthModule` gli dà `AuthPort` e, istanziando `JwtStrategy`, registra in Passport la strategia
 * che `JwtAuthGuard` userà. I guard e i decoratori di ruolo arrivano invece da
 * `auth/access-control.port.ts` e non dagli `exports` di quel modulo: `@UseGuards()` li referenzia
 * per classe, e Nest li istanzia qui — è il modulo che dichiara il controller a fornirne le
 * dipendenze.
 */
@Module({
  imports: [ConfigModule, PlatformModule, AuthModule],
  controllers: [HealthController, AuthController],
})
export class GatewayModule {}
