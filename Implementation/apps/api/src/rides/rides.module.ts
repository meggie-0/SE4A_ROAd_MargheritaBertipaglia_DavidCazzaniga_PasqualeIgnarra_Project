import { Module } from '@nestjs/common';

import { AllocationModule } from '../allocation/allocation.module';
import { ExternalModule } from '../external/external.module';
import { FleetModule } from '../fleet/fleet.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import { AdvanceBookingActivator } from './advance-booking.activator';
import { AdvanceBookingActivatorPort } from './advance-booking.port';
import { AdvanceBookingSchedule } from './advance-booking.schedule';
import { RideAllocator } from './ride-allocator';
import { RideRequestManager } from './ride-request.manager';
import { RideRequestPort } from './rides.port';

/**
 * Il modulo `rides` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **due porte** — `RideRequestPort`, le tre operazioni del servizio, e
 * `AdvanceBookingActivatorPort`, il punto in cui un'esecuzione periodica entra nel dominio
 * (decisione D33). `RideRequestManager`, `AdvanceBookingActivator`, `RideAllocator` e lo scheduler
 * restano dentro.
 *
 * Gli `imports` sono i quattro archi che la Figura 2.1 dà a questo componente più `external`, che
 * la figura ometteva: senza tempi di viaggio non esiste la finestra limitata che la decisione D8
 * pretende da ogni riserva (decisione D29). `notifications` mancherà fino a M5.
 *
 * `rides` importa `AllocationModule` **e** `FleetModule`, ed è lui a fare da tramite fra i due: i
 * candidati li chiede a `fleet` e li passa dentro `allocate()`. È così che `allocation` resta
 * indipendente da `fleet` (DD §2.2.1, decisione D5).
 */
@Module({
  imports: [PersistenceModule, PlatformModule, ExternalModule, FleetModule, AllocationModule],
  providers: [
    RideAllocator,
    AdvanceBookingSchedule,
    { provide: RideRequestPort, useClass: RideRequestManager },
    { provide: AdvanceBookingActivatorPort, useClass: AdvanceBookingActivator },
  ],
  exports: [RideRequestPort, AdvanceBookingActivatorPort], // SOLO le porte
})
export class RidesModule {}
