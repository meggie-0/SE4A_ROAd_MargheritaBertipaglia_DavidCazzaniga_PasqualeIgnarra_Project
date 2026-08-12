import type { RebalancingStatus } from '@road/shared';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { RebalancingActionRecord } from '../persistence.port';

/**
 * `rebalancing_action` — un veicolo mandato a riposizionarsi verso una zona (RASD §2.2.3, R11, G9).
 *
 * La tabella nasce con M6 per la stessa ragione per cui `ride` è nata con M5: lo schema iniziale
 * copre le undici tabelle che MILESTONES.md §M1 elenca, e questa non è fra quelle. È il
 * `RebalancingManager` a chiederla — senza, la zona di destinazione di un riposizionamento non
 * sarebbe scritta da nessuna parte, perché `FleetMonitor.requestRebalancing()` non la riceve
 * (DD §2.2, nota all'operazione).
 */
@Entity({ name: 'rebalancing_action' })
@Index('rebalancing_action_robotaxi_idx', ['robotaxiId', 'createdAt'])
export class RebalancingActionEntity implements RebalancingActionRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'robotaxi_id', type: 'varchar', length: 40 })
  robotaxiId!: string;

  @Column({ name: 'target_zone_id', type: 'varchar', length: 60 })
  targetZoneId!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: RebalancingStatus;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
