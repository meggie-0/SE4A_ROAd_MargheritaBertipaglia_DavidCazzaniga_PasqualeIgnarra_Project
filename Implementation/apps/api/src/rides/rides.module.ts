import { Module } from '@nestjs/common';

import { AllocationModule } from '../allocation/allocation.module';
import { ExternalModule } from '../external/external.module';
import { FleetModule } from '../fleet/fleet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import { AdvanceBookingActivator } from './advance-booking.activator';
import { AdvanceBookingActivatorPort } from './advance-booking.port';
import { AdvanceBookingSchedule } from './advance-booking.schedule';
import { RideAllocator } from './ride-allocator';
import { RideJournal } from './ride-journal';
import { RideLifecycle } from './ride-lifecycle';
import { RideLifecyclePort } from './ride-lifecycle.port';
import { RideRequestManager } from './ride-request.manager';
import { RideRequestPort } from './rides.port';

/**
 * Il modulo `rides` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **tre porte** — `RideRequestPort`, le tre operazioni del servizio;
 * `AdvanceBookingActivatorPort`, il punto in cui un'esecuzione periodica entra nel dominio
 * (decisione D33); e `RideLifecyclePort`, con cui una corsa già assegnata avanza fino a
 * destinazione (M5). `RideRequestManager`, `AdvanceBookingActivator`, `RideAllocator`, `RideJournal`
 * e lo scheduler restano dentro, e con loro l'oggetto `Ride`.
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
    { provide: RideRequestPort, useClass: RideRequestManager },
    { provide: AdvanceBookingActivatorPort, useClass: AdvanceBookingActivator },
    { provide: RideLifecyclePort, useClass: RideLifecycle },
  ],
  // SOLO le porte
  exports: [RideRequestPort, AdvanceBookingActivatorPort, RideLifecyclePort],
})
export class RidesModule {}
