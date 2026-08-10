import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { ZoneRecord } from '../persistence.port';

/**
 * `zone` — una partizione dell'area urbana (RASD §2.2.1).
 *
 * Nessuna colonna raggio, di proposito: le zone formano una partizione di Voronoi sui centroidi
 * e l'appartenenza si calcola con `nearestZone()` di `@road/shared` (DD §2.2.1, decisione D10).
 * Un raggio lascerebbe punti scoperti e sovrapposizioni, che una partizione esclude.
 *
 * L'identificatore è uno slug leggibile (`duomo`, `san-siro`) e non un UUID: i pareggi di ogni
 * ordinamento del sistema si rompono sull'id crescente, e in un test è molto più chiaro leggere
 * `bicocca` che una stringa esadecimale.
 */
@Entity({ name: 'zone' })
export class ZoneEntity implements ZoneRecord {
  @PrimaryColumn({ type: 'varchar', length: 60 })
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'double precision' })
  lat!: number;

  @Column({ type: 'double precision' })
  lon!: number;
}
