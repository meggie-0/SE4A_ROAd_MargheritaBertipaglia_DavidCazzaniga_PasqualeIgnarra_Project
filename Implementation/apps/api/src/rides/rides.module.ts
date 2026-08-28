import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AllocationModule } from '../allocation/allocation.module';
import { ExternalModule } from '../external/external.module';
import { FleetModule } from '../fleet/fleet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import { AdvanceBookingActivator } from './advance-booking.activator';
import { AdvanceBookingActivatorPort } from './advance-booking.port';
import { AdvanceBookingSchedule } from './advance-booking.schedule';
import { FleetTelemetry } from './fleet-telemetry';
import { FleetTelemetryPort } from './fleet-telemetry.port';
import { FleetTelemetrySchedule } from './fleet-telemetry.schedule';
import { RideAllocator } from './ride-allocator';
import { RideJournal } from './ride-journal';
import { RideLifecycle } from './ride-lifecycle';
import { RideLifecyclePort } from './ride-lifecycle.port';
import { RideRequestManager } from './ride-request.manager';
import { RideRequestPort } from './rides.port';

/**
 * Il modulo `rides` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **quattro porte** — `RideRequestPort`, le tre operazioni del servizio;
 * `AdvanceBookingActivatorPort`, il punto in cui un'esecuzione periodica entra nel dominio
 * (decisione D33); `RideLifecyclePort`, con cui una corsa già assegnata avanza fino a destinazione
 * (M5); e `FleetTelemetryPort`, il giro periodico che legge la telemetria della flotta e innesca
 * quelle transizioni quando il veicolo è arrivato davvero (M7, decisione D61).
 * `RideRequestManager`, `AdvanceBookingActivator`, `RideAllocator`, `RideJournal`, `FleetTelemetry`
 * e gli scheduler restano dentro, e con loro l'oggetto `Ride`.
 *
 * Gli `imports` sono i quattro archi che la Figura 2.1 dà a questo componente più `external`, che
 * la figura ometteva: senza tempi di viaggio non esiste la finestra limitata che la decisione D8
 * pretende da ogni riserva (decisione D29). Con M5 arriva `notifications`: la `Ride` è un `Subject`
 * del DD §2.3.3, e l'unico observer che ci si registra sopra è il `NotificationManager`.
 *
 * `rides` importa `AllocationModule` **e** `FleetModule`, ed è lui a fare da tramite fra i due: i
 * candidati li chiede a `fleet` e li passa dentro `allocate()`. È così che `allocation` resta
 * indipendente da `fleet` (DD §2.2.1, decisione D5).
 */
@Module({
  imports: [
    // `rides` legge dall'ambiente l'anticipo di attivazione delle prenotazioni (decisione D76).
    ConfigModule,
    PersistenceModule,
    PlatformModule,
    ExternalModule,
    FleetModule,
    AllocationModule,
    NotificationsModule,
  ],
  providers: [
    RideAllocator,
    RideJournal,
    AdvanceBookingSchedule,
    FleetTelemetrySchedule,
    { provide: RideRequestPort, useClass: RideRequestManager },
    { provide: AdvanceBookingActivatorPort, useClass: AdvanceBookingActivator },
    { provide: RideLifecyclePort, useClass: RideLifecycle },
    { provide: FleetTelemetryPort, useClass: FleetTelemetry },
  ],
  // SOLO le porte
  exports: [RideRequestPort, AdvanceBookingActivatorPort, RideLifecyclePort, FleetTelemetryPort],
})
export class RidesModule {}
