import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AllocationModule } from '../allocation/allocation.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';

import { AllocationController } from './allocation.controller';
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
 *
 * `AllocationModule` gli dà `AllocationPort`, con cui `AllocationController` legge e cambia la
 * strategia attiva (M3, R8). È il primo endpoint riservato all'operatore, e usa i guard di M1b
 * senza aggiungere nulla al meccanismo.
 */
@Module({
  imports: [ConfigModule, PlatformModule, AuthModule, AllocationModule],
  controllers: [HealthController, AuthController, AllocationController],
})
export class GatewayModule {}
