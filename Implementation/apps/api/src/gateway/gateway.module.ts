import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AllocationModule } from '../allocation/allocation.module';
import { AuthModule } from '../auth/auth.module';
import { FleetModule } from '../fleet/fleet.module';
import { ModeModule } from '../mode/mode.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PlatformModule } from '../platform/platform.module';
import { RebalancingModule } from '../rebalancing/rebalancing.module';
import { RidesModule } from '../rides/rides.module';

import { AllocationController } from './allocation.controller';
import { AuthController } from './auth.controller';
import { ControlModeController } from './control-mode.controller';
import { FleetController } from './fleet.controller';
import { HealthController } from './health.controller';
import { NotificationsGateway } from './notifications.gateway';
import { RebalancingController } from './rebalancing.controller';
import { RidesController } from './rides.controller';

import { MaintenanceModule } from '../maintenance/maintenance.module';
import { MaintenanceController } from './maintenance.controller';
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
 * non è un controller HTTP, e resta fedele alla stessa regola: apre un trasporto e delega.
 *
 * `FleetModule` arriva con M8 e gli dà `FleetMonitorPort`, con cui `FleetController` pubblica la
 * panoramica in tempo reale che la dashboard disegna sulla mappa (R7, G8). È l'unico modulo che il
 * gateway ha aspettato tre milestone prima di importare, e vale la pena dire perché: la porta
 * esiste dal M2, ma finché nessun client la guardava una rotta che la esponesse sarebbe stata una
 * funzionalità non richiesta. Vale qui la stessa disciplina di `notifications`: il gateway inietta
 * la porta per **leggere**, e non chiama nessuna delle sue transizioni — un gateway che potesse
 * assegnare o far partire un veicolo aggirerebbe le guardie della Figura 2.10.
 *
 * `ModeModule` e `RebalancingModule` arrivano con M6. Il primo dà `ModePort`, con cui
 * `ControlModeController` legge il modo e riabilita Auto e con cui `AllocationController` inoltra
 * la scelta manuale dell'operatore — la `PUT` della strategia passa da `setManual()`, come la
 * Figura 2.6 prescrive, e non più direttamente da `AllocationPort` (R12, R13, NFR9, NFR10). Il
 * secondo dà `RebalancingPort`, con cui `RebalancingController` pubblica l'analisi della domanda
 * (R10, G9). Nessuno dei due espone il proprio scheduler: le esecuzioni periodiche non hanno un
 * endpoint, e l'unica porta di quel genere che il gateway potrebbe vedere — `TrafficMonitorPort` —
 * non viene iniettata da nessun controller.
 *
 * Delle due porte di `notifications` il gateway **inietta soltanto quella delle sessioni**.
 * L'altra — `NotificationPort`, quella dei *soggetti* — resta iniettabile, perché importare un
 * modulo rende disponibile tutto ciò che esporta: la disciplina è nel codice, non nel contenitore.
 * Il motivo per cui vale la pena tenerla: un gateway che chiamasse `update()` sarebbe un gateway
 * capace di inventare eventi di dominio, cioè di raccontare ai client cose mai accadute.
 */
@Module({
  imports: [
    ConfigModule,
    PlatformModule,
    AuthModule,
    AllocationModule,
    RidesModule,
    NotificationsModule,
    ModeModule,
    RebalancingModule,
    FleetModule,
    MaintenanceModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    AllocationController,
    RidesController,
    ControlModeController,
    RebalancingController,
    FleetController,
    MaintenanceController,
  ],
  providers: [NotificationsGateway],
})
export class GatewayModule {}
