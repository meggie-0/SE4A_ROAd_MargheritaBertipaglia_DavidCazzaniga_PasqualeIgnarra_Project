import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ExternalServicesPort } from '../external/external-services.port';
import { FleetMonitorPort } from '../fleet/fleet-monitor.port';
import {
  CANCELLABLE_STATES,
  ConcurrentTransitionError,
  IllegalTransitionError,
} from '../fleet/robotaxi.port';
import {
  PersistencePort,
  activationDueAt,
  advanceReservationWindow,
  immediateReservationWindow,
  type NewRecord,
  type ReservationTiming,
  type RideRequestRecord,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import { RideAllocator } from './ride-allocator';
import { RideJournal } from './ride-journal';
import { readReservationTiming } from './rides.config';
import {
  RideNotCancellableError,
  RideRequestNotFoundError,
  RideRequestPort,
  ScheduledPickupNotInFutureError,
  type AdvanceBookingDraft,
  type AssignedVehicleLocation,
  type RideCancellation,
  type RideRequestDraft,
  type RideRequestOutcome,
  type PassengerBooking,
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
 * La notifica al passeggero che le Figure 2.5 e 2.8 mettono in coda a ogni ramo arriva con M5, e
 * **non passa di qui**: questo componente apre la corsa attraverso `RideJournal`, e a notificare è
 * la `Ride` — un `Subject` del DD §2.3.3 — verso l'unico observer registrato. `rides` non scrive una
 * riga sulla tabella `notification`, che è una responsabilità che il DD §2.2 assegna al
 * `NotificationManager` e a nessun altro.
 */
@Injectable()
export class RideRequestManager extends RideRequestPort {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly fleet: FleetMonitorPort,
    private readonly allocator: RideAllocator,
    private readonly clock: ClockPort,
    /** Apre e chiude la `Ride`, il secondo soggetto dell'Observer (M5, DD §2.3.3). */
    private readonly journal: RideJournal,
    /**
     * Il comando alla flotta (M7).
     *
     * Serve a un solo passo, l'annullamento: revocare la rotta di un veicolo che si stava già
     * muovendo verso il punto di ritiro, che è ciò che completa R14 (decisione D59). I tempi di
     * viaggio delle altre due operazioni passano invece da `RideAllocator`, che li chiede alla
     * stessa porta — l'arco verso `external` esiste dal M4 (decisione D29), qui cambia solo chi lo
     * percorre.
     */
    private readonly external: ExternalServicesPort,
    config: ConfigService,
  ) {
    super();
    this.timing = readReservationTiming(config);
  }

  /**
   * L'anticipo con cui una prenotazione diventa assegnazione, e il buffer delle riserve.
   *
   * Si legge una volta sola, alla composizione: cambiarlo a metà sessione produrrebbe prenotazioni
   * accettate con anticipi diversi, e `activationDueAt` è persistito proprio per congelare
   * l'anticipo con cui **quella** prenotazione è stata accettata.
   */
  private readonly timing: ReservationTiming;

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
        immediateReservationWindow(
          now,
          travel.etaToPickupMinutes,
          travel.estimatedRideMinutes,
          this.timing,
        ),
      // La corsa immediata assegna subito: è la differenza fra le Figure 2.5 e 2.8.
      assign: true,
    });

    if (!result.allocated) return this.reject(request);

    // `assignedRobotaxiId` l'ha già scritto `reserve()`, nella stessa transazione della riserva
    // (decisione D35): qui resta solo lo stato della richiesta.
    const accepted = await this.persistence.update('ride_request', request.id, {
      status: 'ACCEPTED',
    });

    // La richiesta accettata genera la corsa (RASD §2.2.1). Il veicolo è già assegnato, quindi la
    // corsa nasce sapendo chi la farà.
    await this.journal.open(accepted, result.robotaxi.id, now);

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

    /**
     * I candidati di una prenotazione sono i veicoli **prenotabili**, non quelli allocabili adesso
     * (decisione D34).
     *
     * La Figura 2.8 scrive `getCandidates(pickup)`, la stessa chiamata della corsa immediata, ma le
     * due domande sono diverse: qui la corsa è fra due ore, e un veicolo che in questo momento sta
     * portando qualcun altro a destinazione sarà libero molto prima. Con `getCandidates()` una
     * flotta impegnata rifiuterebbe **ogni** prenotazione futura, cioè R4 funzionerebbe solo quando
     * non serve. A dire chi è davvero occupato in quella finestra è la timeline, qui sotto.
     */
    const candidates = await this.fleet.getBookableRobotaxis();

    /**
     * Il filtro sulla timeline della Figura 2.8, con la finestra **nominale** della decisione D31.
     *
     * La finestra reale dipende dall'ETA del veicolo scelto, che a questo punto non si conosce
     * ancora: la sequenza del DD non è eseguibile alla lettera. Con ETA zero si ottiene la finestra
     * più stretta possibile, contenuta in ogni finestra reale, quindi il filtro non scarta mai un
     * candidato che sarebbe stato idoneo. Se poi la finestra reale collide, a rifiutarla è il
     * vincolo di esclusione dentro `reserve()`, che è dove D8 e C1 vogliono che si decida.
     */
    const nominalWindow = advanceReservationWindow(
      draft.scheduledPickup,
      0,
      estimatedRideMinutes,
      this.timing,
    );
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
          this.timing,
        ),
      // Prenotazione e riserva nella **stessa transazione**: o entrambe le righe o nessuna.
      bookingFor: (robotaxiId) => ({
        robotaxiId,
        scheduledPickup: draft.scheduledPickup,
        activationDueAt: activationDueAt(draft.scheduledPickup, this.timing),
        activatedAt: null,
        closedAt: null,
      }),
      // Il veicolo resta libero fino all'attivazione (decisione D9).
      assign: false,
    });

    if (!result.allocated) return this.reject(request);

    const accepted = await this.persistence.update('ride_request', request.id, {
      status: 'ACCEPTED',
    });

    // La corsa nasce **senza veicolo**: quello è riservato, non assegnato, e lo diventerà
    // all'attivazione (decisione D9). È l'attivatore a scrivercelo.
    await this.journal.open(accepted, null, now);

    return {
      accepted: true,
      request: accepted,
      robotaxiId: result.robotaxi.id,
      reservation: result.reservation,
      booking: result.booking,
    };
  }

  async listBookings(passengerId: string): Promise<readonly PassengerBooking[]> {
    /*
     * Si leggono solamente le richieste anticipate accettate del passeggero.
     * Non esiste alcun limite sul loro numero.
     */
    const requests = await this.persistence.find('ride_request', {
      where: {
        passengerId,
        kind: 'ADVANCE',
        status: 'ACCEPTED',
      },
    });

    if (requests.length === 0) return [];

    /*
     * `closedAt: null` identifica una prenotazione non annullata e non
     * ancora elaborata dall'attivatore.
     */
    const bookings = await this.persistence.find('booking', {
      where: { closedAt: null },
      orderBy: [{ field: 'scheduledPickup', direction: 'asc' }],
    });

    const requestsById = new Map(requests.map((request) => [request.id, request] as const));

    return bookings.flatMap((booking) => {
      const request = requestsById.get(booking.rideRequestId);

      return request === undefined
        ? []
        : [
            {
              request,
              booking,
            },
          ];
    });
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
      await this.persistence.update('robotaxi_reservation', reservation.id, { releasedAt: now });
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
        : await this.persistence.update('booking', booking.id, {
            reservationId: null,
            // Chiusa senza essere mai stata attivata: l'attivatore non deve più prenderla in
            // considerazione, e `activatedAt` resta nullo perché nessuna assegnazione è avvenuta.
            closedAt: now,
          });

    const cancelled = await this.persistence.update('ride_request', rideRequestId, {
      status: 'CANCELLED',
      assignedRobotaxiId: null,
    });

    // La corsa si chiude insieme alla richiesta, e la notifica parte da lei: il passeggero deve
    // vedere l'annullamento anche quando nessun veicolo era stato assegnato — nel qual caso il
    // `Robotaxi` non ha nessuna transizione da raccontare, perché non si è mosso.
    await this.journal.advance(rideRequestId, 'CANCELLED', now);

    return {
      request: cancelled,
      releasedRobotaxiId,
      releasedReservations: reservations.length,
      booking: cancelledBooking,
    };
  }

  /**
   * Dove si trova il veicolo della **propria** corsa (M8, decisione D69).
   *
   * Due letture e nessuna scrittura: la richiesta, per stabilire che è di chi la chiede e che ha un
   * veicolo, e la posizione di quel veicolo, che a `fleet` si chiede attraverso la sua porta come
   * ogni altra cosa. Il controllo di appartenenza è lo stesso di `cancel()`, e per la stessa
   * ragione: una corsa altrui non è un errore di autorizzazione, è una richiesta che per quel
   * passeggero non esiste.
   *
   * **Ciò che questo metodo non fa** è raccontare lo stato del veicolo. La posizione la restituisce,
   * lo stato no, e non è una dimenticanza: lo stato viaggia sul canale push (R6), e duplicarlo qui
   * darebbe al client un secondo modo di scoprire una transizione — che è esattamente ciò che NFR2
   * vieta di dover fare.
   */
  async getAssignedVehicle(
    rideRequestId: string,
    passengerId: string,
  ): Promise<AssignedVehicleLocation | null> {
    const [request] = await this.persistence.find('ride_request', {
      where: { id: rideRequestId },
      limit: 1,
    });
    if (request === undefined || request.passengerId !== passengerId) {
      throw new RideRequestNotFoundError(rideRequestId);
    }

    // Nessun veicolo assegnato: una prenotazione accettata e non ancora attivata sta qui, e non è
    // un errore (decisione D9). Lo stesso vale per una richiesta rifiutata o annullata.
    if (request.assignedRobotaxiId === null) return null;

    const status = await this.fleet.getFleetStatus();
    const vehicle = status.robotaxis.find((one) => one.id === request.assignedRobotaxiId);
    if (vehicle === undefined) return null;

    return {
      robotaxiId: vehicle.id,
      position: { lat: vehicle.lat, lon: vehicle.lon },
      observedAt: vehicle.updatedAt,
    };
  }

  /**
   * Riporta ad `AVAILABLE` il veicolo assegnato alla richiesta, se ce n'è uno (transizione 11).
   *
   * Traduce i due rifiuti della macchina a stati in errori del dominio, e li tiene **distinti**:
   *
   * - `IllegalTransitionError` significa che il passeggero è già a bordo, cioè che la corsa è
   *   cominciata davvero (transizioni 11, 12 e 13: si annulla da `ASSIGNED`, `ARRIVING` e
   *   `ARRIVED`, non da `IN_RIDE`). Ripetere la chiamata non cambierà nulla.
   * - `ConcurrentTransitionError` significa che la transizione era legale quando si è letto e non
   *   lo era più quando si è scritto. Ripetere ha senso, ed è la differenza che il passeggero deve
   *   poter vedere. Senza questo ramo l'errore uscirebbe grezzo dal manager e diventerebbe un 500:
   *   un guasto annunciato per una corsa che nel frattempo è semplicemente partita.
   *
   * Entrambi restano possibili anche dopo il controllo preventivo qui sotto — fra la lettura dello
   * stato e la scrittura, la telemetria può far salire il passeggero — ma allora sono davvero una
   * corsa persa e non il caso ordinario. Il veicolo a cui in quella finestra è stata revocata la
   * rotta la riceve di nuovo al giro di telemetria successivo, che ricomanda la destinazione
   * proprio per questo (`FleetTelemetry`, ramo `IN_RIDE`).
   */
  private async releaseVehicle(request: RideRequestRecord): Promise<string | null> {
    if (request.assignedRobotaxiId === null) return null;

    /**
     * **Prima si guarda se l'annullamento è ammesso, poi si tocca la flotta.**
     *
     * La revoca della rotta non è una scrittura che si possa disfare: ferma un veicolo in strada.
     * Farla prima di sapere se la transizione sarà accettata significherebbe fermare il veicolo di
     * un passeggero **già a bordo** per poi rifiutare l'annullamento — l'esito peggiore possibile,
     * e per giunta con la chiamata che risponde «non ho fatto niente». La promessa della porta è
     * che un rifiuto non lasci nulla dietro di sé, e vale per il mondo fisico prima ancora che per
     * il database.
     *
     * Lo stato lo dà `fleet`, che è chi lo possiede: qui non si decide se la transizione è legale
     * — quello lo fa la classe di stato un istante dopo — si decide se vale la pena **comandare
     * qualcosa alla flotta**. La finestra fra questa lettura e la scrittura resta possibile ed è
     * gestita sotto, dove è sempre stata.
     */
    const { robotaxis } = await this.fleet.getFleetStatus();
    const vehicle = robotaxis.find((one) => one.id === request.assignedRobotaxiId);
    if (vehicle !== undefined && !CANCELLABLE_STATES.includes(vehicle.state)) {
      throw new RideNotCancellableError(request.id, 'RIDE_ALREADY_UNDER_WAY', vehicle.state);
    }

    try {
      /**
       * **Prima si revoca la rotta, poi si libera il veicolo** (R14, decisione D27, M7).
       *
       * È l'ordine che rende legale l'annullamento da `ARRIVING` e da `ARRIVED`, e non è
       * intercambiabile: dichiarare disponibile un veicolo che sta ancora percorrendo una rotta
       * verso un passeggero che ha annullato significherebbe poterlo assegnare a qualcun altro
       * mentre continua ad andare dove non serve più. Il DD §2.6.3 lo dice nella nota alla
       * transizione 11: fermare un veicolo in movimento è un comando alla flotta, e viene prima
       * della transizione del ciclo di vita.
       *
       * La revoca è **innocua** se il veicolo non si era mosso — il caso `ASSIGNED`, l'unico
       * ammesso fino a M6 — perché nessuna rotta gli era stata comandata e la flotta non ha niente
       * da revocare.
       */
      await this.external.commandRoute(request.assignedRobotaxiId, null);

      await this.fleet.releaseAssignment(request.assignedRobotaxiId);
      return request.assignedRobotaxiId;
    } catch (error) {
      if (error instanceof IllegalTransitionError) {
        // Il veicolo è **già** disponibile: la riserva era stata scritta ma l'assegnazione non è
        // mai avvenuta — è la finestra che resta dopo D35, ed è quella innocua. Lo scopo di questo
        // passo è che il veicolo sia libero, e lo è: l'annullamento prosegue invece di bloccarsi su
        // una corsa che nessun veicolo sta servendo.
        if (error.from === 'AVAILABLE') return null;
        throw new RideNotCancellableError(request.id, 'RIDE_ALREADY_UNDER_WAY', error.from);
      }
      if (error instanceof ConcurrentTransitionError) {
        throw new RideNotCancellableError(
          request.id,
          'VEHICLE_CHANGED_CONCURRENTLY',
          error.expected,
        );
      }
      throw error;
    }
  }

  /** La richiesta che nessun veicolo può servire: `REJECTED` in colonna, non un'eccezione. */
  private async reject(request: RideRequestRecord): Promise<RideRequestOutcome> {
    const rejected = await this.persistence.update('ride_request', request.id, {
      status: 'REJECTED',
      // Il legame si azzera insieme al rifiuto: un tentativo andato male può aver lasciato scritto
      // un veicolo che poi ha rifiutato l'assegnazione, e una richiesta rifiutata non ne ha nessuno.
      assignedRobotaxiId: null,
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
