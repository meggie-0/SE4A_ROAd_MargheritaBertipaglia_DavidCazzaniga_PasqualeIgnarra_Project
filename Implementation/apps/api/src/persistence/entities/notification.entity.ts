import type { NotificationType } from '@road/shared';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { NotificationRecord } from '../persistence.port';

/**
 * `notification` — una notifica destinata a un utente (RASD §2.2.3).
 *
 * La tabella è lo storico, non il canale: la consegna in tempo reale è il push di M5, dove
 * `NotificationManager` è l'unico observer registrato su `Robotaxi` e `Ride` (DD §2.3.3). Averla
 * persistita è ciò che permette a un client che si riconnette di non perdere ciò che è successo
 * mentre era assente.
 */
@Entity({ name: 'notification' })
@Index('notification_recipient_idx', ['recipientId', 'createdAt'])
export class NotificationEntity implements NotificationRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'recipient_id', type: 'uuid' })
  recipientId!: string;

  @Column({ name: 'ride_request_id', type: 'uuid', nullable: true })
  rideRequestId!: string | null;

  @Column({ type: 'varchar', length: 40 })
  type!: NotificationType;

  @Column({ type: 'varchar', length: 500 })
  message!: string;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
