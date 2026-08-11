import { Injectable } from '@nestjs/common';
import type { GeoPoint } from '@road/shared';

import { FleetMonitorPort } from '../fleet/fleet-monitor.port';
import { IllegalTransitionError } from '../fleet/robotaxi.port';
import {
  PersistencePort,
  activationDueAt,
  advanceReservationWindow,
  immediateReservationWindow,
  type NewRecord,
  type RideRequestRecord,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import { RideAllocator } from './ride-allocator';
import {
  RideNotCancellableError,
  RideRequestNotFoundError,
  RideRequestPort,
  ScheduledPickupNotInFutureError,
  type AdvanceBookingDraft,
  type RideCancellation,
  type RideRequestDraft,
  type RideRequestOutcome,
} from './rides.port';

/**
 * Il `RideRequestManager` (DD §2.2, §2.4): il **coordinatore** del ciclo di vita di una richiesta.
 *
 * Le tre operazioni seguono le Figure 2.5, 2.8 e il paragrafo sull'annullamento, con le divergenze
 * registrate come decisioni D29, D30 e D31 e spiegate nei punti in cui si vedono. Ciò che accomuna
 * i tre metodi è la forma: **persistere la richiesta, chiedere agli altri componenti, scrivere
 * l'esito**. Non c'è una metrica, non c'è una transizione di stato scritta a mano, non c'è un
 * controllo di sovrapposizione: le tre cose stanno rispettivamente in `allocation`, in `fleet` e
 * nel vincolo di esclusione del database, ed è questo che rende il componente sostituibile.
 *
 * La notifica al passeggero, che le Figure 2.5 e 2.8 mettono in coda a ogni ramo, **non c'è
 * ancora**: `NotificationPort` nasce con M5, insieme all'Observer e al trasporto push. Aggiungere
 * qui una scrittura diretta sulla tabella `notification` significherebbe dare a `rides` una
 * responsabilità che il DD §2.2 attribuisce al `NotificationManager`, e M5 dovrebbe disfarla.
 */
@Injectable()
export class RideRequestManager extends RideRequestPort {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly fleet: FleetMonitorPort,
    private readonly allocator: RideAllocator,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async submitImmediate(draft: RideRequestDraft): Promise<RideRequestOutcome> {
    const now = this.clock.now();
    const request = await this.persistence.create(
      'ride_request',
      newRideRequest(draft, 'IMMEDIATE'),
    );

    const estimatedRideMinutes = await this.allocator.estimateRideMinutes(
      draft.pickup,
      draft.destination,
    );
    if (estimatedRideMinutes === null) return this.reject(request);

    const candidates = await this.fleet.getCandidates();
    const result = await this.allocator.run({
      rideRequestId: request.id,
      pickup: draft.pickup,
      candidates,
      estimatedRideMinutes,
      windowFor: (travel) =>
        immediateReservationWindow(now, travel.etaToPickupMinutes, travel.estimatedRideMinutes),
      // La corsa immediata assegna subito: è la differenza fra le Figure 2.5 e 2.8.
      assign: true,
    });

    if (!result.allocated) return this.reject(request);

    const accepted = await this.persistence.update('ride_request', request.id, {
      status: 'ACCEPTED',
      assignedRobotaxiId: result.robotaxi.id,
    });

    return {
      accepted: true,
      request: accepted,
      robotaxiId: result.robotaxi.id,
      reservation: result.reservation,
      booking: null,
    };
  }

  async submitAdvance(draft: AdvanceBookingDraft): Promise<RideRequestOutcome> {
    const now = this.clock.now();
    // La validazione precede la scrittura: una richiesta malformata non lascia una riga in
    // `PENDING` che nessuno raccoglierà mai (DD §2.4, `validateAdvanceRequest()`).
    if (draft.scheduledPickup.getTime() <= now.getTime()) {
      throw new ScheduledPickupNotInFutureError(draft.scheduledPickup, now);
    }

    const request = await this.persistence.create('ride_request', newRideRequest(draft, 'ADVANCE'));

    const estimatedRideMinutes = await this.allocator.estimateRideMinutes(
      draft.pickup,
      draft.destination,
    );
    if (estimatedRideMinutes === null) return this.reject(request);

    const candidates = await this.fleet.getCandidates();

    /**
     * Il filtro sulla timeline della Figura 2.8, con la finestra **nominale** della decisione D31.
     *
     * La finestra reale dipende dall'ETA del veicolo scelto, che a questo punto non si conosce
     * ancora: la sequenza del DD non è eseguibile alla lettera. Con ETA zero si ottiene la finestra
     * più stretta possibile, contenuta in ogni finestra reale, quindi il filtro non scarta mai un
     * candidato che sarebbe stato idoneo. Se poi la finestra reale collide, a rifiutarla è il
     * vincolo di esclusione dentro `reserve()`, che è dove D8 e C1 vogliono che si decida.
     */
    const nominalWindow = advanceReservationWindow(draft.scheduledPickup, 0, estimatedRideMinutes);
    const freeIds = new Set(
      await this.persistence.filterAvailable(
        candidates.map((candidate) => candidate.id),
        nominalWindow,
      ),
    );

    const result = await this.allocator.run({
      rideRequestId: request.id,
      pickup: draft.pickup,
      candidates: candidates.filter((candidate) => freeIds.has(candidate.id)),
      estimatedRideMinutes,
      windowFor: (travel) =>
        advanceReservationWindow(
          draft.scheduledPickup,
          travel.etaToPickupMinutes,
          travel.estimatedRideMinutes,
        ),
      // Prenotazione e riserva nella **stessa transazione**: o entrambe le righe o nessuna.
      bookingFor: (robotaxiId) => ({
        robotaxiId,
        scheduledPickup: draft.scheduledPickup,
        activationDueAt: activationDueAt(draft.scheduledPickup),
        activatedAt: null,
      }),
      // Il veicolo resta libero fino all'attivazione (decisione D9).
      assign: false,
    });

    if (!result.allocated) return this.reject(request);

    const accepted = await this.persistence.update('ride_request', request.id, {
      status: 'ACCEPTED',
    });

    return {
      accepted: true,
      request: accepted,
      robotaxiId: result.robotaxi.id,
      reservation: result.reservation,
      booking: result.booking,
    };
  }

  async cancel(rideRequestId: string, passengerId: string): Promise<RideCancellation> {
    const [request] = await this.persistence.find('ride_request', {
      where: { id: rideRequestId },
      limit: 1,
    });
    if (request === undefined || request.passengerId !== passengerId) {
      throw new RideRequestNotFoundError(rideRequestId);
    }
    if (request.status !== 'PENDING' && request.status !== 'ACCEPTED') {
      throw new RideNotCancellableError(rideRequestId, 'REQUEST_NOT_ACTIVE', request.status);
    }

    // **Prima il veicolo, poi la riserva.** La transizione 11 è l'unico passo che può rifiutare, e
    // rifiuta senza scrivere nulla: mettendola per prima, un annullamento arrivato troppo tardi
    // lascia la riserva in piedi e la richiesta intatta. Nell'ordine opposto avrebbe liberato la
    // finestra di una corsa che sta comunque per essere servita.
    const releasedRobotaxiId = await this.releaseVehicle(request);

    const now = this.clock.now();
    const reservations = await this.persistence.find('robotaxi_reservation', {
      where: { rideRequestId, releasedAt: null },
    });
    for (const reservation of reservations) {
      await this.allocator.releaseReservation(reservation.id, now);
    }

    // La prenotazione perde il puntatore alla riserva rilasciata, come lo schema di M1 prescrive.
    // La riga resta: serve allo storico, e la riserva rilasciata continua a puntare alla richiesta.
    const [booking] = await this.persistence.find('booking', {
      where: { rideRequestId },
      limit: 1,
    });
    const cancelledBooking =
      booking === undefined
        ? null
        : await this.persistence.update('booking', booking.id, { reservationId: null });

    const cancelled = await this.persistence.update('ride_request', rideRequestId, {
      status: 'CANCELLED',
      assignedRobotaxiId: null,
    });

    return {
      request: cancelled,
      releasedRobotaxiId,
      releasedReservations: reservations.length,
      booking: cancelledBooking,
    };
  }

  /**
   * Riporta ad `AVAILABLE` il veicolo assegnato alla richiesta, se ce n'è uno (transizione 11).
   *
   * Traduce il rifiuto della macchina a stati in un errore del dominio: `IllegalTransitionError`
   * qui significa che il veicolo si è già mosso verso il punto di ritiro, cioè che la corsa è
   * cominciata — un fatto che il passeggero deve poter capire, e non un guasto.
   */
  private async releaseVehicle(request: RideRequestRecord): Promise<string | null> {
    if (request.assignedRobotaxiId === null) return null;

    try {
      await this.fleet.releaseAssignment(request.assignedRobotaxiId);
      return request.assignedRobotaxiId;
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        throw new RideNotCancellableError(request.id, 'RIDE_ALREADY_UNDER_WAY', error.from);
      }
      throw error;
    }
  }

  /** La richiesta che nessun veicolo può servire: `REJECTED` in colonna, non un'eccezione. */
  private async reject(request: RideRequestRecord): Promise<RideRequestOutcome> {
    const rejected = await this.persistence.update('ride_request', request.id, {
      status: 'REJECTED',
    });
    return { accepted: false, request: rejected, reason: 'NO_ELIGIBLE_ROBOTAXI' };
  }
}

/**
 * La riga da scrivere per una richiesta appena arrivata: `PENDING`, senza veicolo.
 *
 * Le coordinate si sdoppiano in colonne perché nel RASD §2.2.1 `Location` è un valore e non
 * un'entità; la conversione sta qui, in un punto solo, e non dentro i due metodi che la userebbero
 * identica.
 */
function newRideRequest(
  draft: RideRequestDraft,
  kind: 'IMMEDIATE' | 'ADVANCE',
): NewRecord<'ride_request'> {
  return {
    passengerId: draft.passengerId,
    kind,
    status: 'PENDING',
    pickupLat: draft.pickup.lat,
    pickupLon: draft.pickup.lon,
    pickupAddress: draft.pickupAddress ?? null,
    destinationLat: draft.destination.lat,
    destinationLon: draft.destination.lon,
    destinationAddress: draft.destinationAddress ?? null,
    assignedRobotaxiId: null,
  };
}

/** Il punto di ritiro di una richiesta persistita, per chi la rilegge (l'attivatore). */
export function pickupOf(request: RideRequestRecord): GeoPoint {
  return { lat: request.pickupLat, lon: request.pickupLon };
}

/** La destinazione di una richiesta persistita. */
export function destinationOf(request: RideRequestRecord): GeoPoint {
  return { lat: request.destinationLat, lon: request.destinationLon };
}
