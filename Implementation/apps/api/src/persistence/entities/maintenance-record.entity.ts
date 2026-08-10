import type { MaintenanceStatus } from '@road/shared';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { MaintenanceRecord } from '../persistence.port';

/**
 * `maintenance_record` — un periodo di indisponibilità del veicolo (RASD `MaintenanceEvent`, R9).
 *
 * Lo storico serve alla dashboard e alla tracciabilità; l'esclusione dai candidati passa però
 * dallo **stato** del robotaxi (`MAINTENANCE`), non da una interrogazione su questa tabella: è la
 * macchina a stati del DD §2.6.3 a decidere chi è assegnabile, e M2 la implementa.
 */
@Entity({ name: 'maintenance_record' })
@Index('maintenance_record_robotaxi_idx', ['robotaxiId', 'status'])
export class MaintenanceRecordEntity implements MaintenanceRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'robotaxi_id', type: 'varchar', length: 40 })
  robotaxiId!: string;

  @Column({ type: 'varchar', length: 255 })
  reason!: string;

  @Column({ type: 'varchar', length: 20 })
  status!: MaintenanceStatus;

  @Column({ name: 'started_at', type: 'timestamptz' })
  startedAt!: Date;

  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;
}
