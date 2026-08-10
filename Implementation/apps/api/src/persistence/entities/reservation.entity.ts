import { Column, Entity, PrimaryColumn } from 'typeorm';

import type { ReservationRecord, TimeWindow } from '../persistence.port';
import { formatTstzRange, parseTstzRange } from '../range';

/**
 * `robotaxi_reservation` — il veicolo è impegnato per una corsa in una finestra di tempo.
 *
 * È la tabella su cui vive l'invariante centrale del progetto:
 *
 * ```sql
 * EXCLUDE USING gist (robotaxi_id WITH =, period WITH &&)
 * ```
 *
 * Due riserve dello stesso veicolo non possono sovrapporsi **qualunque sia l'interleaving degli
 * scrittori** (NFR4, vincolo C1 del RASD), perché a impedirlo è il database e non il codice
 * applicativo. È anche il motivo per cui ogni riserva copre un intervallo **limitato** (decisione
 * D8): con un estremo superiore aperto, una corsa in esecuzione bloccherebbe ogni prenotazione
 * futura sullo stesso veicolo.
 *
 * `period` è un `tstzrange` semiaperto `[start, end)`: due finestre che si toccano non si
 * sovrappongono.
 */
@Entity({ name: 'robotaxi_reservation' })
export class ReservationEntity implements ReservationRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ name: 'robotaxi_id', type: 'varchar', length: 40 })
  robotaxiId!: string;

  @Column({ name: 'ride_request_id', type: 'uuid' })
  rideRequestId!: string;

  @Column({
    type: 'tstzrange',
    transformer: {
      to: (window: TimeWindow): string => formatTstzRange(window),
      from: (raw: string): TimeWindow => parseTstzRange(raw),
    },
  })
  period!: TimeWindow;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
