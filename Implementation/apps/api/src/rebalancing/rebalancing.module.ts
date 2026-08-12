import { Module } from '@nestjs/common';

import { ExternalModule } from '../external/external.module';
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
 * Gli `imports` sono i quattro archi che la Figura 2.1 dà a questo componente: `FleetModule` per i
 * veicoli inattivi e per le transizioni 8 e 9, `PersistenceModule` per la domanda e il giornale
 * delle azioni, `NotificationsModule` per l'alert in dashboard e — da M7 — `ExternalModule`, per
 * comandare la rotta verso la zona di destinazione (Figura 2.7) e per sapere dalla telemetria chi è
 * arrivato.
 *
 * L'arco esiste, ma **non per la domanda**: `getDemandData()` resta fuori dalla porta, e la sorgente
 * restano `demand_sample` e `demand_event` lette da `PersistencePort` come la decisione D44
 * consente. La D47 rimandava l'operazione a «M7 insieme a un fornitore vero»; di fornitori veri di
 * domanda per Milano non ce n'è nessuno collegabile, quindi resta rimandata (decisione D62).
 */
@Module({
  imports: [PersistenceModule, PlatformModule, FleetModule, NotificationsModule, ExternalModule],
  providers: [RebalancingScheduler, { provide: RebalancingPort, useClass: RebalancingManager }],
  exports: [RebalancingPort], // SOLO la porta
})
export class RebalancingModule {}
