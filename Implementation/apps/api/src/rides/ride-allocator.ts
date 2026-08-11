import { Injectable } from '@nestjs/common';
import type { GeoPoint } from '@road/shared';

import { AllocationPort } from '../allocation/allocation.port';
import { ExternalServicesPort } from '../external/external-services.port';
import { FleetMonitorPort } from '../fleet/fleet-monitor.port';
import {
  ConcurrentTransitionError,
  IllegalTransitionError,
  type RobotaxiSnapshot,
} from '../fleet/robotaxi.port';
import {
  PersistencePort,
  type BookingRecord,
  type ReservationInput,
  type ReservationRecord,
  type TimeWindow,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

/**
 * Il tratto comune fra la richiesta immediata, la prenotazione anticipata e la ri-allocazione
 * all'attivazione: **scegliere un veicolo e impegnarlo davvero**.
 *
 * Non è una porta e non esce dal modulo: è la parte di `RideRequestManager` che `AdvanceBookingActivator`
 * riusa, e i due vivono in `rides` (CLAUDE.md Regola 1). Sta in un file a sé perché la sequenza
 * «scegli, prenota, assegna, e se non riesci riprova con un altro» compare in tre punti del DD
 * §2.4 — Figure 2.5, 2.8 e il diagramma di attivazione — e scriverla tre volte significherebbe
 * avere tre versioni che divergono al primo difetto corretto in una sola di esse.
 *
 * Ciò che questo file **non** fa: non sceglie con quale metrica (lo fa la strategia attiva, dietro
 * `AllocationPort`), non decide quali transizioni sono ammesse (lo fanno le classi di stato, dietro
 * `FleetMonitorPort`) e non controlla le sovrapposizioni (lo fa il vincolo di esclusione del
 * database, dietro `PersistencePort.reserve()`).
 *
 * **Una conseguenza dell'estrazione, da tenere presente leggendo la Figura 2.1.** Gli archi
 * `RideRequestManager --( IAllocationService` e `--( IExternalServices` esistono a livello di
 * modulo — `rides.module.ts` importa entrambi — ma non si leggono più aprendo la classe che nella
 * figura porta quel nome: le due porte sono iniettate qui. È il prezzo di non avere la stessa
 * sequenza scritta in tre punti, ed è dichiarato perché chi confronta il codice con il documento
 * non lo scambi per un arco mancante.
 */

/** I due tempi di viaggio da cui dipende la finestra da riservare (DD §2.4, decisione D8). */
export interface RideTravelTimes {
  readonly etaToPickupMinutes: number;
  readonly estimatedRideMinutes: number;
}

/** La prenotazione da scrivere nella stessa transazione della riserva, se la corsa è anticipata. */
type NewBooking = NonNullable<ReservationInput['booking']>;

export interface RideAllocationRequest {
  readonly rideRequestId: string;
  readonly pickup: GeoPoint;
  /** I candidati già filtrati da chi chiama: per stato, e per una prenotazione anche sulla timeline. */
  readonly candidates: readonly RobotaxiSnapshot[];
  /** La durata stimata della corsa, calcolata una volta sola da `estimateRideMinutes()`. */
  readonly estimatedRideMinutes: number;
  /** La finestra da riservare, una volta noti i tempi di viaggio del veicolo scelto. */
  readonly windowFor: (travel: RideTravelTimes) => TimeWindow;
  /** Presente solo alla prima scrittura di una prenotazione anticipata. */
  readonly bookingFor?: (robotaxiId: string) => NewBooking;
  /**
   * Se il veicolo va anche portato ad `ASSIGNED`.
   *
   * È `false` per una prenotazione anticipata appena accettata, e non è un dettaglio: fino
   * all'attivazione il veicolo è *riservato* e resta libero di servire corse immediate che si
   * concludono prima della finestra prenotata. Assegnarlo subito lo toglierebbe dalla flotta per
   * tutto il tempo che manca all'orario concordato.
   */
  readonly assign: boolean;
}

export type RideAllocationResult =
  | {
      readonly allocated: true;
      readonly robotaxi: RobotaxiSnapshot;
      readonly reservation: ReservationRecord;
      readonly booking: BookingRecord | null;
      readonly travel: RideTravelTimes;
    }
  | { readonly allocated: false };

/**
 * L'identificatore con cui si chiede l'ETA del tragitto **della corsa**, dal ritiro alla
 * destinazione.
 *
 * `ExternalServicesPort.getETA()` associa gli esiti alle origini per identificatore, e qui
 * l'origine è un punto e non un veicolo: serve un nome, e questo dice cos'è.
 */
const PICKUP_ORIGIN_ID = 'pickup';

@Injectable()
export class RideAllocator {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly fleet: FleetMonitorPort,
    private readonly allocation: AllocationPort,
    private readonly external: ExternalServicesPort,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Quanto dura la corsa, dal ritiro alla destinazione, in minuti.
   *
   * Non dipende dal veicolo, quindi si calcola **una volta per richiesta**: serve alla finestra da
   * riservare (decisione D8) e, per una prenotazione, anche alla finestra nominale con cui si
   * filtrano i candidati (decisione D31), che va costruita prima di sapere chi la servirà.
   *
   * `null` significa che il fornitore non sa rispondere per quella coppia di punti. Non è
   * un'ipotesi teorica: la porta dichiara che un'origine sconosciuta non compare nell'esito, e
   * l'adapter OSRM di M7 la userà. Senza una durata non esiste una finestra **limitata** da
   * riservare, e una riserva illimitata è ciò che la decisione D8 vieta.
   */
  async estimateRideMinutes(pickup: GeoPoint, destination: GeoPoint): Promise<number | null> {
    const [estimate] = await this.external.getETA(
      [{ id: PICKUP_ORIGIN_ID, position: pickup }],
      destination,
    );
    return finiteMinutes(estimate?.etaMinutes);
  }

  /**
   * Sceglie, prenota e — se richiesto — assegna, riprovando fra i candidati rimanenti.
   *
   * Il ciclo è la parte che conta. `allocate()` restituisce **un** veicolo, e fra quel momento e la
   * scrittura della riserva possono succedere due cose che nessun controllo preventivo eviterebbe:
   * un'altra transazione ha già preso quel veicolo (`ROBOTAXI_BUSY`), oppure la sua finestra si
   * sovrappone a una riserva esistente (`OVERLAPPING_RESERVATION`, rifiutata dal vincolo di
   * esclusione). Entrambe sono esiti previsti e non guasti: si toglie quel candidato e si richiede
   * la scelta alla strategia attiva, che è il comportamento utile quando due passeggeri chiedono
   * insieme l'ultimo veicolo (NFR1).
   *
   * Il ciclo termina sempre: `remaining` perde un elemento a ogni giro.
   */
  async run(request: RideAllocationRequest): Promise<RideAllocationResult> {
    let remaining = [...request.candidates];

    while (remaining.length > 0) {
      const chosen = await this.allocation.allocate({ pickup: request.pickup }, remaining);
      // Nessuno dei rimanenti è idoneo secondo la strategia attiva: riprovare con gli stessi
      // candidati darebbe la stessa risposta.
      if (chosen === null) return { allocated: false };

      remaining = remaining.filter((candidate) => candidate.id !== chosen.id);

      const etaToPickupMinutes = await this.etaToPickup(chosen, request.pickup);
      // Un veicolo di cui non si sa il tempo di arrivo non ha una finestra calcolabile: si passa
      // al successivo invece di inventarne una.
      if (etaToPickupMinutes === null) continue;

      const travel = { etaToPickupMinutes, estimatedRideMinutes: request.estimatedRideMinutes };
      const outcome = await this.persistence.reserve({
        robotaxiId: chosen.id,
        rideRequestId: request.rideRequestId,
        window: request.windowFor(travel),
        ...(request.bookingFor === undefined ? {} : { booking: request.bookingFor(chosen.id) }),
      });

      if (!outcome.reserved) continue;

      if (
        request.assign &&
        !(await this.assignOrRelease(chosen.id, request.rideRequestId, outcome.reservation.id))
      ) {
        continue;
      }

      return {
        allocated: true,
        robotaxi: chosen,
        reservation: outcome.reservation,
        booking: outcome.booking,
        travel,
      };
    }

    return { allocated: false };
  }

  /**
   * Rilascia la riserva appena scritta, quando l'assegnazione che doveva seguirla non è riuscita
   * (decisione D19).
   *
   * È **privato**: il rilascio di una riserva in generale — quello dell'annullamento, quello della
   * ri-allocazione — appartiene a chi possiede quella riserva, e i due chiamanti hanno già
   * `PersistencePort` iniettata. Farlo passare da una classe che si chiama `RideAllocator` sarebbe
   * un giro che confonde il lettore su chi decide quando una riserva finisce. Qui c'è solo il caso
   * che questa classe ha creato lei e deve disfare lei.
   */
  private async releaseOwnReservation(reservationId: string): Promise<void> {
    await this.persistence.update('robotaxi_reservation', reservationId, {
      releasedAt: this.clock.now(),
    });
  }

  /**
   * Porta il veicolo ad `ASSIGNED`; se la macchina a stati rifiuta, **rilascia la riserva appena
   * scritta** e riferisce di riprovare.
   *
   * Il rifiuto qui significa una cosa sola: fra la lettura dei candidati e questa chiamata qualcun
   * altro ha cambiato lo stato di quel veicolo — l'ha assegnato, o l'ha mandato in officina.
   * Lasciare la riserva in piedi bloccherebbe la finestra di un veicolo che questa corsa non avrà.
   */
  private async assignOrRelease(
    robotaxiId: string,
    rideRequestId: string,
    reservationId: string,
  ): Promise<boolean> {
    try {
      await this.fleet.assign(robotaxiId, { rideRequestId });
      return true;
    } catch (error) {
      if (error instanceof IllegalTransitionError || error instanceof ConcurrentTransitionError) {
        await this.releaseOwnReservation(reservationId);
        return false;
      }
      throw error;
    }
  }

  /** Il tempo di arrivo del veicolo al punto di ritiro, in minuti. */
  private async etaToPickup(robotaxi: RobotaxiSnapshot, pickup: GeoPoint): Promise<number | null> {
    const [estimate] = await this.external.getETA(
      [{ id: robotaxi.id, position: { lat: robotaxi.lat, lon: robotaxi.lon } }],
      pickup,
    );
    return finiteMinutes(estimate?.etaMinutes);
  }
}

/**
 * Il valore se è un numero finito e non negativo, `null` altrimenti.
 *
 * `NaN` e infinito arrivano da una posizione mancante — telemetria non ancora ricevuta — e non sono
 * confrontabili né sommabili: una finestra costruita su di essi non sarebbe un intervallo. È la
 * stessa regola con cui `bestScored()` scarta un candidato dal punteggio non finito (decisione D25).
 */
function finiteMinutes(minutes: number | undefined): number | null {
  if (minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return null;
  return minutes;
}
