import type { RideStatus } from '@road/shared';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { RideRecord } from '../persistence.port';

/**
 * `ride` — il servizio di trasporto generato da una richiesta accettata (RASD §2.2.3, M5).
 *
 * È il secondo **soggetto** dell'Observer del DD §2.3.3, accanto a `Robotaxi`: la riga qui è ciò da
 * cui l'oggetto `Ride` si ricostruisce a ogni operazione, esattamente come lo stato del veicolo si
 * ricostruisce dalla sua colonna enum (§2.6.3). Il modulo `rides` è l'unico che la scrive.
 *
 * Come per `ride_request`, le posizioni sono coppie di coordinate e non una tabella `location`:
 * nel RASD `Location` è un valore, non un'entità con identità propria.
 */
@Entity({ name: 'ride' })
@Index('ride_passenger_idx', ['passengerId', 'createdAt'])
export class RideEntity implements RideRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  /** Unica in schema: una richiesta genera **al più una** corsa (RASD Figura 2.3, `1 --> 0..1`). */
  @Column({ name: 'ride_request_id', type: 'uuid' })
  rideRequestId!: string;

  @Column({ name: 'passenger_id', type: 'uuid' })
  passengerId!: string;

  /**
   * Il veicolo che serve la corsa.
   *
   * Annullabile perché una corsa nasce `SCHEDULED` anche quando il veicolo è solo *riservato*: per
   * una prenotazione anticipata l'assegnazione arriva all'attivazione (decisione D9), e fino a quel
   * momento chiamare assegnato un veicolo prometterebbe più di quanto il sistema garantisca.
   */
  @Column({ name: 'robotaxi_id', type: 'varchar', length: 40, nullable: true })
  robotaxiId!: string | null;

  @Column({ type: 'varchar', length: 30 })
  status!: RideStatus;

  @Column({ name: 'pickup_lat', type: 'double precision' })
  pickupLat!: number;

  @Column({ name: 'pickup_lon', type: 'double precision' })
  pickupLon!: number;

  @Column({ name: 'destination_lat', type: 'double precision' })
  destinationLat!: number;

  @Column({ name: 'destination_lon', type: 'double precision' })
  destinationLon!: number;

  /**
   * Quando il veicolo è arrivato al punto di ritiro: la corsa passa a `WAITING_FOR_PICKUP` (M9).
   *
   * È il momento da cui si conta la sosta della decisione D63 — quanto il sistema aspetta prima di
   * assumere che il passeggero sia salito. Nulla finché il veicolo non è arrivato, e nulla per le
   * corse che precedono la migrazione che l'ha introdotta.
   */
  @Column({ name: 'pickup_reached_at', type: 'timestamptz', nullable: true })
  pickupReachedAt!: Date | null;

  /** Quando il passeggero è salito: la corsa passa a `IN_PROGRESS` (RASD §1.2.2). */
  @Column({ name: 'started_at', type: 'timestamptz', nullable: true })
  startedAt!: Date | null;

  /** Quando la corsa si è chiusa, completata o annullata che sia. */
  @Column({ name: 'ended_at', type: 'timestamptz', nullable: true })
  endedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
