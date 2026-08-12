import { Injectable } from '@nestjs/common';
import type { RideStatus } from '@road/shared';

import { FleetMonitorPort } from '../fleet/fleet-monitor.port';
import {
  PersistencePort,
  type RideRequestRecord,
  type TimeWindow,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import { RideJournal } from './ride-journal';
import {
  RideLifecyclePort,
  RideNotInProgressError,
  type RideProgress,
} from './ride-lifecycle.port';

/**
 * L'avanzamento di una corsa assegnata: le transizioni 4, 5, 6 e 7 della Figura 2.10 (M5).
 *
 * Ogni passo ha la stessa forma, ed è la forma che il DD §2.4 dà a tutte le operazioni di questo
 * componente: **il veicolo prima, la corsa poi**. L'ordine non è indifferente. La transizione del
 * veicolo è l'unico passo che può *rifiutare* — la macchina a stati lo fa senza scrivere niente
 * (NFR5) — quindi metterla per prima significa che un passo fuori tempo lascia la corsa esattamente
 * com'era. Nell'ordine opposto la corsa risulterebbe avanzata su un veicolo che non si è mosso, e
 * il passeggero avrebbe ricevuto la notifica di un fatto mai accaduto.
 *
 * Non contiene una riga di logica di transizione: chiede a `FleetMonitorPort` e a `RideJournal`, che
 * a loro volta delegano alle classi di stato e all'oggetto `Ride`. Se qui comparisse uno `switch`
 * sullo stato del veicolo, il pattern State sarebbe scritto due volte (CLAUDE.md Regola 2).
 */
@Injectable()
export class RideLifecycle extends RideLifecyclePort {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly fleet: FleetMonitorPort,
    private readonly journal: RideJournal,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async startPickupNavigation(rideRequestId: string): Promise<RideProgress> {
    // La corsa resta `SCHEDULED`: è il veicolo che si muove, non il patto che cambia.
    return this.step(
      rideRequestId,
      (robotaxiId) => this.fleet.startPickupNavigation(robotaxiId),
      null,
    );
  }

  async pickupReached(rideRequestId: string): Promise<RideProgress> {
    return this.step(
      rideRequestId,
      (robotaxiId) => this.fleet.pickupReached(robotaxiId),
      'WAITING_FOR_PICKUP',
    );
  }

  async startRide(rideRequestId: string): Promise<RideProgress> {
    return this.step(
      rideRequestId,
      (robotaxiId) => this.fleet.startRide(robotaxiId),
      'IN_PROGRESS',
    );
  }

  async completeRide(rideRequestId: string): Promise<RideProgress> {
    const progress = await this.step(
      rideRequestId,
      (robotaxiId) => this.fleet.completeRide(robotaxiId),
      'COMPLETED',
    );

    const endedAt = this.clock.now();

    /**
     * La riserva si **chiude sull'istante effettivo** (decisione D8).
     *
     * La finestra era una stima — ETA più durata più buffer — e la corsa è finita prima o dopo.
     * Lasciarla com'era terrebbe il veicolo impegnato per un tempo che non serve più a nessuno, e
     * decisione D8 dice esplicitamente che «il limite superiore si chiude all'istante effettivo
     * quando la corsa termina». È il primo punto del sistema in cui una corsa termina davvero,
     * quindi è il primo in cui quella frase ha un chiamante.
     *
     * Si **accorcia**, non si rilascia: la riserva è stata onorata, e il tempo già consumato resta
     * occupato. Il rilascio per intero è la semantica dell'annullamento (R14), che è un'altra cosa.
     * Un accorciamento non può collidere con nessuna riserva, quindi non serve gestire conflitti.
     */
    const reservations = await this.persistence.find('robotaxi_reservation', {
      where: { rideRequestId, releasedAt: null },
    });
    for (const reservation of reservations) {
      if (reservation.period.end.getTime() <= endedAt.getTime()) continue;
      const shortened: TimeWindow = {
        start: reservation.period.start,
        // Un intervallo vuoto è vietato dallo schema: se la corsa finisce prima ancora che la
        // finestra cominci, si chiude sull'inizio più un istante — il caso non si dà con un ETA
        // sensato, ma lo schema non ammette eccezioni e nemmeno questo codice.
        end:
          endedAt.getTime() > reservation.period.start.getTime()
            ? endedAt
            : new Date(reservation.period.start.getTime() + 1),
      };
      await this.persistence.update('robotaxi_reservation', reservation.id, { period: shortened });
    }

    // La richiesta ha ottenuto ciò che chiedeva: `COMPLETED` è lo stato che il RASD §2.2.1 le dà.
    const request = await this.persistence.update('ride_request', rideRequestId, {
      status: 'COMPLETED',
    });

    return { ...progress, request };
  }

  /**
   * Un passo: valida la corsa, muove il veicolo, fa avanzare la corsa.
   *
   * `nextStatus` è annullabile perché non tutti i passi cambiano lo stato della corsa — la partenza
   * verso il punto di ritiro non lo fa — e in quel caso non parte una seconda notifica: quella del
   * veicolo ha già detto tutto.
   */
  private async step(
    rideRequestId: string,
    transition: (robotaxiId: string) => Promise<unknown>,
    nextStatus: RideStatus | null,
  ): Promise<RideProgress> {
    const request = await this.activeRequest(rideRequestId);
    const robotaxiId = request.assignedRobotaxiId;
    if (robotaxiId === null) {
      throw new RideNotInProgressError(rideRequestId, 'NO_ASSIGNED_ROBOTAXI');
    }

    // Il veicolo per primo: è l'unico passo che può rifiutare, e rifiuta senza scrivere nulla.
    await transition(robotaxiId);

    const at = this.clock.now();
    // Un passo che non cambia lo stato della corsa la restituisce comunque: il chiamante deve poter
    // vedere dov'è, non dedurre da un `null` che non esista.
    const ride =
      nextStatus === null
        ? await this.journal.find(rideRequestId)
        : await this.journal.advance(rideRequestId, nextStatus, at);

    return { request, ride, robotaxiId, rideStatus: ride?.status ?? null };
  }

  /** La richiesta, se esiste ed è ancora quella di una corsa in corso. */
  private async activeRequest(rideRequestId: string): Promise<RideRequestRecord> {
    const [request] = await this.persistence.find('ride_request', {
      where: { id: rideRequestId },
      limit: 1,
    });
    if (request === undefined) {
      throw new RideNotInProgressError(rideRequestId, 'UNKNOWN_REQUEST');
    }
    if (request.status !== 'ACCEPTED') {
      throw new RideNotInProgressError(rideRequestId, 'REQUEST_NOT_ACTIVE');
    }
    return request;
  }
}
