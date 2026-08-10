import type { RideRequestKind, RideRequestStatus } from '@road/shared';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { RideRequestRecord } from '../persistence.port';

/**
 * `ride_request` — la richiesta di trasporto di un passeggero (RASD §2.2.1).
 *
 * `ImmediateRide` e `AdvanceBooking` del modello di dominio sono una sola tabella con una colonna
 * `kind`: il dato specifico della prenotazione (orario programmato, attivazione) sta in `booking`,
 * che esiste solo per le richieste anticipate. Due tabelle separate avrebbero duplicato pickup,
 * destinazione e stato senza aggiungere nulla.
 *
 * Le posizioni sono coppie di coordinate e non una tabella `location`: nel RASD `Location` è un
 * valore, non un'entità con identità propria.
 */
@Entity({ name: 'ride_request' })
@Index('ride_request_status_idx', ['status'])
export class RideRequestEntity implements RideRequestRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'passenger_id', type: 'uuid' })
  passengerId!: string;

  @Column({ type: 'varchar', length: 20 })
  kind!: RideRequestKind;

  @Column({ type: 'varchar', length: 20 })
  status!: RideRequestStatus;

  @Column({ name: 'pickup_lat', type: 'double precision' })
  pickupLat!: number;

  @Column({ name: 'pickup_lon', type: 'double precision' })
  pickupLon!: number;

  @Column({ name: 'pickup_address', type: 'varchar', length: 255, nullable: true })
  pickupAddress!: string | null;

  @Column({ name: 'destination_lat', type: 'double precision' })
  destinationLat!: number;

  @Column({ name: 'destination_lon', type: 'double precision' })
  destinationLon!: number;

  @Column({ name: 'destination_address', type: 'varchar', length: 255, nullable: true })
  destinationAddress!: string | null;

  /** Valorizzata quando la richiesta è accettata; torna `null` se la corsa viene annullata (R14). */
  @Column({ name: 'assigned_robotaxi_id', type: 'varchar', length: 40, nullable: true })
  assignedRobotaxiId!: string | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
