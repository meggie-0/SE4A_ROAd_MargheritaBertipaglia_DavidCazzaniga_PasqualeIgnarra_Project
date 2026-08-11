import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { DemandSampleRecord } from '../persistence.port';

/**
 * `demand_sample` — la domanda di base per zona e fascia oraria settimanale.
 *
 * È il primo dei due livelli del modello di domanda (MILESTONES.md §M1): la base storica, che gli
 * eventi di `demand_event` moltiplicano. `analyzeDemand()` di M6 li combina come da decisione D12:
 *
 * ```
 * domandaAttesa(z, t) = base(z, fasciaOrariaSettimanale(t)) × Π moltiplicatore(e)
 * ```
 *
 * I dati sono **simulati**: il RASD §2.6 tratta la sorgente di domanda come dipendenza esterna, e
 * finché M7 non collega un fornitore vero, il seed la sostituisce.
 */
@Entity({ name: 'demand_sample' })
@Index('demand_sample_slot_uq', ['zoneId', 'dayOfWeek', 'hourOfDay'], { unique: true })
export class DemandSampleEntity implements DemandSampleRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'zone_id', type: 'varchar', length: 60 })
  zoneId!: string;

  /** 0 = domenica … 6 = sabato, la convenzione di `Date.getUTCDay()`. */
  @Column({ name: 'day_of_week', type: 'smallint' })
  dayOfWeek!: number;

  @Column({ name: 'hour_of_day', type: 'smallint' })
  hourOfDay!: number;

  /** Corse attese nell'ora, in quella zona. Un numero, non un livello: D12 lo moltiplica. */
  @Column({ name: 'base_demand', type: 'double precision' })
  baseDemand!: number;
}
