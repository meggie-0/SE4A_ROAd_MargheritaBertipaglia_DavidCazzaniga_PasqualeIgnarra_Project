import type { ControlMode, StrategyName, TrafficLevel } from '@road/shared';
import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { SystemModeRecord } from '../persistence.port';

/**
 * `system_mode` — strategia attiva e modo di controllo, in **una riga sola**.
 *
 * È l'unica sede autorevole dei due valori (DD §2.2.1, decisione D6): tenerli in memoria li
 * farebbe divergere fra repliche del tier applicativo, che NFR3 vuole intercambiabili. La riga è
 * un singleton garantito da un `CHECK (id = 'singleton')` nella migrazione: senza, due righe
 * renderebbero ambigua la domanda "qual è la strategia attiva?".
 *
 * `last_traffic_level` è l'ultimo livello letto da `TrafficMonitor`. Serve a `enableAuto()`, che
 * deve rivalutarlo **subito** al ritorno in modo Auto (decisione D11): una replica che non ha
 * gestito l'ultima lettura non lo saprebbe, se non fosse persistito.
 */
@Entity({ name: 'system_mode' })
export class SystemModeEntity implements SystemModeRecord {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id!: string;

  @Column({ name: 'active_strategy', type: 'varchar', length: 40 })
  activeStrategy!: StrategyName;

  @Column({ type: 'varchar', length: 20 })
  mode!: ControlMode;

  @Column({ name: 'last_traffic_level', type: 'varchar', length: 20, nullable: true })
  lastTrafficLevel!: TrafficLevel | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

/**
 * L'unico identificatore ammesso dalla riga singleton.
 *
 * La costante è definita in `persistence.port.ts` — da M3 la usa anche `AllocationManager`, che le
 * entità non può vederle — e ri-esportata qui perché la migrazione e il seed la cercano dove
 * l'hanno sempre trovata.
 */
export { SYSTEM_MODE_ID } from '../persistence.port';
