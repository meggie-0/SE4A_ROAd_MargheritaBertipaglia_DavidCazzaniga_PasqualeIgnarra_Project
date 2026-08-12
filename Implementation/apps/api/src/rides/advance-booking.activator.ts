import { Injectable } from '@nestjs/common';

import { FleetMonitorPort } from '../fleet/fleet-monitor.port';
import {
  ConcurrentTransitionError,
  IllegalTransitionError,
  type RobotaxiSnapshot,
} from '../fleet/robotaxi.port';
import {
  PersistencePort,
  advanceReservationWindow,
  type BookingRecord,
  type RideRequestRecord,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import {
  AdvanceBookingActivatorPort,
  type ActivationReport,
  type BookingActivation,
} from './advance-booking.port';
import { destinationOf, pickupOf } from './ride-request-geo';
import { RideAllocator } from './ride-allocator';
import { RideJournal } from './ride-journal';

/**
 * L'attivatore delle prenotazioni anticipate (DD §2.4, decisione D9).
 *
 * Esiste perché **una prenotazione non è un'assegnazione**: lo scenario 2 del RASD chiede che «poco
 * prima dell'orario il sistema attivi la riserva», e fra l'accettazione e l'orario concordato
 * possono passare giorni, durante i quali il veicolo riservato può finire in officina. Il ritardo
 * è la ragione per cui l'attivazione **rivalida** invece di fidarsi.
 *
 * Non c'è nessun timer qui dentro (CLAUDE.md Regola 3): `runOnce()` è pubblico e lo chiamano lo
 * scheduler in produzione — vedi `advance-booking.schedule.ts` — e i test direttamente, con un
 * orologio finto.
 */
@Injectable()
export class AdvanceBookingActivator extends AdvanceBookingActivatorPort {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly fleet: FleetMonitorPort,
    private readonly allocator: RideAllocator,
    private readonly clock: ClockPort,
    /** La corsa esiste già dalla prenotazione: qui si scrive chi la farà (M5). */
    private readonly journal: RideJournal,
  ) {
    super();
  }

  async runOnce(now: Date = this.clock.now()): Promise<ActivationReport> {
    /**
     * `findBookingsDueAt(now)` della Figura del §2.4.
     *
     * La condizione è su `activation_due_at`, che è `orario − anticipo` **congelato al momento
     * della prenotazione**: cercare per orario e sottrarre l'anticipo qui darebbe un risultato
     * diverso se la configurazione cambiasse fra l'accettazione e l'attivazione, cioè cambierebbe
     * retroattivamente il patto fatto con il passeggero.
     *
     * L'ordinamento è totale — prima le più urgenti, pareggi sull'id — perché quando due
     * prenotazioni si contendono l'ultimo veicolo l'esito non deve dipendere dall'ordine con cui il
     * database ha restituito le righe.
     *
     * Il filtro è su `closedAt` e non su `activatedAt`: una prenotazione rifiutata all'attivazione
     * non è mai stata attivata — e `activatedAt` resta giustamente nullo — ma la sua sorte è decisa,
     * quindi non deve ricadere qui a ogni esecuzione per sempre.
     */
    const due = await this.persistence.find('booking', {
      where: { closedAt: null, activationDueAt: { atMost: now } },
      orderBy: [{ field: 'activationDueAt' }, { field: 'id' }],
    });

    const activations: BookingActivation[] = [];
    for (const booking of due) {
      const activation = await this.activate(booking, now);
      if (activation !== null) activations.push(activation);
    }

    return { ranAt: now, activations };
  }

  /** Una prenotazione: la si attiva com'è, la si ri-alloca, o la si rifiuta. */
  private async activate(booking: BookingRecord, now: Date): Promise<BookingActivation | null> {
    const [request] = await this.persistence.find('ride_request', {
      where: { id: booking.rideRequestId },
      limit: 1,
    });

    // Una prenotazione annullata nel frattempo (R14) non è un esito dell'attivazione: non c'è
    // niente da attivare, e la sua riserva è già stata rilasciata da `cancel()`, che chiude anche
    // la prenotazione. Questo controllo resta come rete di sicurezza — se una richiesta cambia
    // stato per una via che oggi non esiste, l'attivazione non la ripesca comunque.
    if (request === undefined || request.status !== 'ACCEPTED') {
      await this.persistence.update('booking', booking.id, { closedAt: now });
      return null;
    }

    const candidates = await this.fleet.getCandidates();
    const reserved = candidates.find((candidate) => candidate.id === booking.robotaxiId);

    // «Ancora idoneo» significa «compare fra i candidati» (decisione D32): un veicolo in
    // `REBALANCING` lo è, perché la transizione 10 interrompe il riposizionamento e assegna la
    // corsa — ed è esattamente il caso per cui quella transizione esiste.
    if (reserved !== undefined) {
      const activated = await this.assignReserved(booking, request, reserved, now);
      if (activated !== null) return activated;
      // L'assegnazione è stata rifiutata fra la lettura dei candidati e la scrittura: il veicolo
      // non è più quello che si era letto, quindi si procede come se non fosse idoneo.
    }

    return this.reallocate(booking, request, candidates, now);
  }

  /** Il cammino ordinario: il veicolo riservato è ancora idoneo e prende la corsa. */
  private async assignReserved(
    booking: BookingRecord,
    request: RideRequestRecord,
    reserved: RobotaxiSnapshot,
    now: Date,
  ): Promise<BookingActivation | null> {
    // Il legame si scrive **prima** dell'assegnazione, per la stessa ragione per cui `reserve()` lo
    // scrive nella propria transazione (decisione D35): se qualcosa interrompe la sequenza dopo la
    // transizione di stato, il veicolo resterebbe `ASSIGNED` senza che nessuna richiesta lo
    // rivendichi, e `cancel()` non saprebbe più a chi restituire la libertà. Nell'ordine giusto la
    // finestra che resta è quella innocua — legame scritto, veicolo ancora libero — che
    // l'annullamento sa già assorbire.
    await this.persistence.update('ride_request', request.id, {
      assignedRobotaxiId: reserved.id,
    });

    try {
      await this.fleet.assign(reserved.id, { rideRequestId: request.id });
    } catch (error) {
      if (error instanceof IllegalTransitionError || error instanceof ConcurrentTransitionError) {
        return null;
      }
      throw error;
    }

    await this.persistence.update('booking', booking.id, { activatedAt: now, closedAt: now });

    // Il veicolo riservato è ora assegnato: la corsa aperta da `submitAdvance` lo scopre adesso.
    // Nessuna notifica parte di qui — l'ha già mandata il veicolo passando ad `ASSIGNED`.
    await this.journal.attachRobotaxi(request.id, reserved.id);

    return {
      bookingId: booking.id,
      rideRequestId: request.id,
      outcome: 'ACTIVATED',
      robotaxiId: reserved.id,
    };
  }

  /**
   * Il veicolo riservato non è più idoneo: si rilascia la sua riserva e si ricomincia la scelta
   * fra i veicoli liberi in quella finestra.
   *
   * La riserva si rilascia **per prima**, e non è indifferente: tenerla bloccherebbe la finestra di
   * un veicolo che questa corsa non avrà comunque — è in officina — impedendo a un'altra
   * prenotazione di usarlo quando ne uscirà.
   */
  private async reallocate(
    booking: BookingRecord,
    request: RideRequestRecord,
    candidates: readonly RobotaxiSnapshot[],
    now: Date,
  ): Promise<BookingActivation> {
    if (booking.reservationId !== null) {
      await this.persistence.update('robotaxi_reservation', booking.reservationId, {
        releasedAt: now,
      });
    }

    const pickup = pickupOf(request);
    const result = await this.chooseAnother(booking, request, candidates, pickup);

    if (result === null) {
      // Nessun veicolo idoneo in quella finestra: è il ramo `[request rejected]` della Figura 3.2
      // del RASD. `activatedAt` resta nullo — nessuna assegnazione è avvenuta — ma la prenotazione
      // si **chiude**, o ricadrebbe fra le dovute a ogni esecuzione per sempre. Il legame si azzera
      // insieme: un tentativo può averlo lasciato scritto, e una richiesta rifiutata non ha veicolo.
      await this.persistence.update('ride_request', request.id, {
        status: 'REJECTED',
        assignedRobotaxiId: null,
      });
      await this.persistence.update('booking', booking.id, { closedAt: now });
      // Nessun veicolo potrà servirla: la corsa si chiude, ed è da lei che il passeggero lo sa.
      await this.journal.advance(request.id, 'CANCELLED', now);
      return {
        bookingId: booking.id,
        rideRequestId: request.id,
        outcome: 'REJECTED',
        robotaxiId: null,
      };
    }

    // `assignedRobotaxiId` l'ha già scritto `reserve()` nella propria transazione (decisione D35).
    await this.persistence.update('booking', booking.id, {
      robotaxiId: result.robotaxiId,
      reservationId: result.reservationId,
      activatedAt: now,
      closedAt: now,
    });

    await this.journal.attachRobotaxi(request.id, result.robotaxiId);

    return {
      bookingId: booking.id,
      rideRequestId: request.id,
      outcome: 'REALLOCATED',
      robotaxiId: result.robotaxiId,
    };
  }

  /**
   * La ri-allocazione vera e propria: stessa sequenza della prenotazione, ma il veicolo si assegna
   * subito — l'orario è arrivato.
   */
  private async chooseAnother(
    booking: BookingRecord,
    request: RideRequestRecord,
    candidates: readonly RobotaxiSnapshot[],
    pickup: ReturnType<typeof pickupOf>,
  ): Promise<{ robotaxiId: string; reservationId: string } | null> {
    const estimatedRideMinutes = await this.allocator.estimateRideMinutes(
      pickup,
      destinationOf(request),
    );
    if (estimatedRideMinutes === null) return null;

    const nominalWindow = advanceReservationWindow(
      booking.scheduledPickup,
      0,
      estimatedRideMinutes,
    );
    const freeIds = new Set(
      await this.persistence.filterAvailable(
        candidates.map((candidate) => candidate.id),
        nominalWindow,
      ),
    );

    const result = await this.allocator.run({
      rideRequestId: request.id,
      pickup,
      candidates: candidates.filter((candidate) => freeIds.has(candidate.id)),
      estimatedRideMinutes,
      windowFor: (travel) =>
        advanceReservationWindow(
          booking.scheduledPickup,
          travel.etaToPickupMinutes,
          travel.estimatedRideMinutes,
        ),
      // La riga di `booking` esiste già: qui si riscrive, non si crea. L'atomicità che M4 pretende
      // riguarda la *nascita* della prenotazione, ed è garantita da `submitAdvance`.
      assign: true,
    });

    return result.allocated
      ? { robotaxiId: result.robotaxi.id, reservationId: result.reservation.id }
      : null;
  }
}
