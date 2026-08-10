import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { DemandEventRecord } from '../persistence.port';

/**
 * `demand_event` — un evento che moltiplica la domanda di una zona per un periodo.
 *
 * È il secondo livello del modello di domanda: la partita a San Siro, il salone a Rho Fiera, lo
 * spettacolo alla Scala. Un evento è **attivo** quando `t ∈ [startsAt, endsAt)` — semiaperto come
 * ogni altro intervallo del sistema, così l'istante di fine non appartiene più all'evento
 * (DD §2.2.1, decisione D12).
 */
@Entity({ name: 'demand_event' })
@Index('demand_event_window_idx', ['zoneId', 'startsAt', 'endsAt'])
export class DemandEventEntity implements DemandEventRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'zone_id', type: 'varchar', length: 60 })
  zoneId!: string;

  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Column({ name: 'starts_at', type: 'timestamptz' })
  startsAt!: Date;

  @Column({ name: 'ends_at', type: 'timestamptz' })
  endsAt!: Date;

  /** Fattore moltiplicativo sulla domanda di base: `2.5` significa "due volte e mezzo". */
  @Column({ type: 'double precision' })
  multiplier!: number;
}
