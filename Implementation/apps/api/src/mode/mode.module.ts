import { Module } from '@nestjs/common';

import { AllocationModule } from '../allocation/allocation.module';
import { ExternalModule } from '../external/external.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import { ModeController } from './mode.controller';
import { ModePort } from './mode.port';
import { TrafficMonitor } from './traffic-monitor';
import { TrafficMonitorPort } from './traffic-monitor.port';
import { TrafficSchedule } from './traffic.schedule';

/**
 * Il modulo `mode` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **due porte**: `ModePort`, le quattro operazioni del DD §2.2.1, e `TrafficMonitorPort`,
 * il punto in cui l'esecuzione periodica entra nel dominio — come `rides` fa con
 * `AdvanceBookingActivatorPort` (decisione D33). `ModeController`, `TrafficMonitor` e lo scheduler
 * restano dentro.
 *
 * Gli `imports` sono i due archi che la Figura 2.1 dà al `ModeController` — `AllocationModule` e
 * `NotificationsModule` — più `PersistenceModule`, che la Figura 2.9 gli attribuisce per la lettura
 * del record `system_mode`, `ExternalModule`, da cui il `TrafficMonitor` legge il traffico, e
 * `PlatformModule` per l'orologio.
 *
 * **`mode` dipende da `allocation` e non viceversa.** È l'arco della Figura 2.1, e il verso conta:
 * se `AllocationManager` chiedesse il permesso a `ModeController` prima di scrivere, i due moduli
 * si importerebbero a vicenda, `pnpm arch` fallirebbe sulla dipendenza circolare, e nessuno dei due
 * sarebbe più riscrivibile da solo.
 */
@Module({
  imports: [
    PersistenceModule,
    PlatformModule,
    ExternalModule,
    AllocationModule,
    NotificationsModule,
  ],
  providers: [
    TrafficSchedule,
    { provide: ModePort, useClass: ModeController },
    { provide: TrafficMonitorPort, useClass: TrafficMonitor },
  ],
  // SOLO le porte
  exports: [ModePort, TrafficMonitorPort],
})
export class ModeModule {}
