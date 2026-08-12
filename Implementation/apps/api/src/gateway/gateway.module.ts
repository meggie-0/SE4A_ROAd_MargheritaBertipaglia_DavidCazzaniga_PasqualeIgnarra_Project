import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AllocationModule } from '../allocation/allocation.module';
import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformModule } from '../platform/platform.module';
import { RidesModule } from '../rides/rides.module';

import { AllocationController } from './allocation.controller';
import { AuthController } from './auth.controller';
import { HealthController } from './health.controller';
import { NotificationsGateway } from './notifications.gateway';
import { RidesController } from './rides.controller';

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
 *
 * `RidesModule` gli dà `RideRequestPort`, con cui `RidesController` pubblica le tre operazioni del
 * passeggero (M4, R3, R4, R14). Il gateway **non** importa `FleetModule` né `PersistenceModule`
 * per servirle: la catena richiesta → candidati → allocazione → riserva → assegnazione la coordina
 * `rides`, e il gateway conosce una porta sola per caso d'uso.
 *
 * `NotificationsModule` gli dà `NotificationSessionPort`, con cui `NotificationsGateway` registra e
 * deregistra le sessioni dei client connessi (M5, R6, G7, NFR2). È il primo pezzo di gateway che
 * non è un controller HTTP, e resta fedele alla stessa regola: apre un trasporto e delega. Nota che
 * **non** riceve `NotificationPort` — quella è la porta dei *soggetti*, e un gateway che potesse
 * chiamare `update()` sarebbe un gateway capace di inventare eventi di dominio.
 */
@Module({
  imports: [
    ConfigModule,
    PlatformModule,
    AuthModule,
    AllocationModule,
    RidesModule,
    NotificationsModule,
  ],
  controllers: [HealthController, AuthController, AllocationController, RidesController],
  providers: [NotificationsGateway],
})
export class GatewayModule {}
