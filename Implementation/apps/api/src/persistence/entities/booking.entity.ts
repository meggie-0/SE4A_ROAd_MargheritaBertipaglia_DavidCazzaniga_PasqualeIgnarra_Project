import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { BookingRecord } from '../persistence.port';

/**
 * `booking` — il dato specifico di una prenotazione anticipata (RASD §2.2.1, `AdvanceBooking`).
 *
 * Nasce insieme alla riserva, **nella stessa transazione** (`PersistencePort.reserve` con il campo
 * `booking`): una prenotazione accettata senza riserva impegnerebbe un veicolo che qualcun altro
 * può prendersi, e una riserva senza prenotazione bloccherebbe un veicolo per nessuno.
 *
 * `activation_due_at` è l'istante in cui `AdvanceBookingActivator.runOnce()` dovrà trasformare la
 * prenotazione in assegnazione (decisione D9): memorizzarlo rende la ricerca delle prenotazioni
 * dovute una disuguaglianza su una colonna indicizzata.
 */
@Entity({ name: 'booking' })
@Index('booking_activation_due_idx', ['activationDueAt'])
export class BookingEntity implements BookingRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'ride_request_id', type: 'uuid', unique: true })
  rideRequestId!: string;

  @Column({ name: 'robotaxi_id', type: 'varchar', length: 40, nullable: true })
  robotaxiId!: string | null;

  /** La riserva che tiene impegnato il veicolo; `null` se è stata rilasciata (annullamento, R14). */
  @Column({ name: 'reservation_id', type: 'uuid', nullable: true })
  reservationId!: string | null;

  @Column({ name: 'scheduled_pickup', type: 'timestamptz' })
  scheduledPickup!: Date;

  @Column({ name: 'activation_due_at', type: 'timestamptz' })
  activationDueAt!: Date;

  @Column({ name: 'activated_at', type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  /**
   * Quando l'attivatore ha finito con questa prenotazione, comunque sia andata.
   *
   * Distinta da `activated_at`, che dice **se** è diventata un'assegnazione: una prenotazione
   * rifiutata all'attivazione, o annullata prima (R14), è chiusa senza essere mai stata attivata.
   * La ricerca delle prenotazioni dovute filtra su questa, o le righe la cui sorte è già decisa
   * ricadrebbero nella ricerca a ogni esecuzione, per sempre.
   */
  @Column({ name: 'closed_at', type: 'timestamptz', nullable: true })
  closedAt!: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
