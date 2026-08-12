import { Module } from '@nestjs/common';

import { FleetModule } from '../fleet/fleet.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import { RebalancingManager } from './rebalancing.manager';
import { RebalancingPort } from './rebalancing.port';
import { RebalancingScheduler } from './rebalancing.schedule';

/**
 * Il modulo `rebalancing` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **solo** `RebalancingPort`, le due operazioni del DD §2.2. `RebalancingManager`, il
 * modello di domanda e lo scheduler restano dentro.
 *
 * Gli `imports` sono tre dei quattro archi che la Figura 2.1 dà a questo componente:
 * `FleetModule` per i veicoli inattivi e per la transizione 8, `PersistenceModule` per la domanda e
 * il giornale delle azioni, `NotificationsModule` per l'alert in dashboard. Il quarto —
 * `ExternalModule` — **non c'è**, ed è la decisione D47: la sorgente di domanda di questo prototipo
 * sono le tabelle `demand_sample` e `demand_event`, che il manager legge da `PersistencePort` come
 * la decisione D44 consente. `getDemandData()` entra in M7 insieme a un fornitore vero, e allora
 * comparirà anche questo arco.
 */
@Module({
  imports: [PersistenceModule, PlatformModule, FleetModule, NotificationsModule],
  providers: [RebalancingScheduler, { provide: RebalancingPort, useClass: RebalancingManager }],
  exports: [RebalancingPort], // SOLO la porta
})
export class RebalancingModule {}
