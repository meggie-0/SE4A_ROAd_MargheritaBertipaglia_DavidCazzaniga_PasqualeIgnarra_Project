import type { RobotaxiState } from '@road/shared';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { RobotaxiRecord } from '../persistence.port';

/**
 * `robotaxi` — un veicolo della flotta (RASD §2.2.1).
 *
 * Lo stato è una **colonna enum**: il comportamento vive nelle classi di stato di M2 e il database
 * memorizza soltanto quale classe istanziare, come prescrive il DD §2.6.3. Sono sette valori, non
 * sei: `REBALANCING` è uno stato a tutti gli effetti (decisione D1).
 *
 * `zone_id` è la zona corrente, derivata dalla posizione con la partizione di Voronoi (D10). È
 * ridondante rispetto a `lat`/`lon` ed è tenuta apposta: il rebalancing di M6 conta i veicoli
 * disponibili per zona, e farlo senza una colonna significherebbe ricalcolare la partizione a ogni
 * interrogazione.
 */
@Entity({ name: 'robotaxi' })
@Index('robotaxi_state_idx', ['state'])
export class RobotaxiEntity implements RobotaxiRecord {
  /** Identificatore leggibile (`RT-01`): i pareggi si rompono sull'id crescente. */
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  state!: RobotaxiState;

  @Column({ type: 'double precision' })
  lat!: number;

  @Column({ type: 'double precision' })
  lon!: number;

  @Column({ name: 'zone_id', type: 'varchar', length: 60, nullable: true })
  zoneId!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
