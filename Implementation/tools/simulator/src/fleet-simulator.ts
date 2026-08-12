import { haversineKm, type GeoPoint } from '@road/shared';

/**
 * Il **simulatore di flotta** di M7: i veicoli che ROAd comanda, quando i veicoli veri non ci sono.
 *
 * MILESTONES.md §M7 lo descrive in una riga: «a ogni `tick()` avanza i veicoli lungo la polyline
 * assegnata e ne pubblica la telemetria». Questo file è quella riga, e nient'altro — non conosce
 * NestJS, non conosce il database, non sa cosa sia una corsa. Chi lo raggiunge è
 * `ExternalServicesPort`, attraverso l'adapter che lo avvolge: è ciò che permette di sostituirlo
 * con veicoli veri senza toccare un manager (NFR8, DD §4.3).
 *
 * **Determinismo** (CLAUDE.md Regola 3). Non c'è orologio e non c'è casualità: il tempo del
 * simulatore è il numero di `tick()` ricevuti, e la posizione di un veicolo è una funzione pura
 * della rotta e di quel numero. È ciò che permette al cancello di M7 di pretendere «un numero
 * deterministico di tick» invece di attendere che qualcosa accada. In esecuzione normale i tick
 * arrivano da un `@Cron` dell'API, che è dove i timer sono ammessi; qui dentro non ce n'è nessuno.
 */

/** Quanto un veicolo si sposta a ogni tick, e a quale velocità. */
export interface FleetSimulatorSettings {
  /**
   * Velocità di crociera in ambito urbano, km/h.
   *
   * Stesso valore e stessa natura della costante che regge la stima lineare degli ETA: è
   * un'**assunzione dichiarata del prototipo**, non un dato misurato. Cambiandola cambia quanti
   * tick servono per arrivare, non chi arriva prima.
   */
  readonly speedKmH: number;
  /** Quanti minuti di mondo simulato vale un `tick()`. */
  readonly tickMinutes: number;
}

export const DEFAULT_SIMULATOR_SETTINGS: FleetSimulatorSettings = {
  speedKmH: 20,
  tickMinutes: 1,
};

/**
 * Ciò che il simulatore pubblica di un veicolo.
 *
 * `hasArrived` è il campo che conta, ed è il motivo per cui la telemetria non si riduce a una
 * coppia di coordinate: le guardie della Figura 2.10 che il backend non sapeva risolvere —
 * `hasReachedPickup()`, `hasReachedDestination()`, `hasReachedTargetArea()` — sono tutte la stessa
 * domanda, «il veicolo è arrivato dove l'ho mandato?», e la risposta la dà chi osserva il veicolo.
 * Farla dedurre al chiamante confrontando coordinate con una soglia avrebbe messo un pezzo di
 * fisica del veicolo dentro un manager di dominio.
 */
export interface VehicleTelemetryReading {
  readonly robotaxiId: string;
  readonly position: GeoPoint;
  /** Dove il veicolo è stato mandato, o `null` se non sta seguendo nessuna rotta. */
  readonly destination: GeoPoint | null;
  /** Quanta strada manca lungo la rotta comandata; zero quando è arrivato o non ne ha una. */
  readonly remainingKm: number;
  readonly hasArrived: boolean;
}

/** Lo stato interno di un veicolo simulato: dov'è e cosa gli resta da percorrere. */
interface SimulatedVehicle {
  position: GeoPoint;
  /** I punti della polyline non ancora raggiunti, nell'ordine in cui vanno percorsi. */
  remaining: GeoPoint[];
  destination: GeoPoint | null;
  hasArrived: boolean;
}

export class FleetSimulator {
  /**
   * I veicoli che il simulatore conosce: **solo quelli a cui è stata comandata una rotta**.
   *
   * Non c'è un censimento iniziale della flotta, e non è una semplificazione: un veicolo fermo che
   * nessuno ha mandato da nessuna parte non produce telemetria perché non ha niente da raccontare,
   * e la sua posizione autorevole è quella in tabella. Se il simulatore li registrasse tutti,
   * l'adapter dovrebbe leggere il database — cioè `external` dipenderebbe da `persistence` per
   * ripetere un dato che già esiste.
   */
  private readonly vehicles = new Map<string, SimulatedVehicle>();

  constructor(private readonly settings: FleetSimulatorSettings = DEFAULT_SIMULATOR_SETTINGS) {}

  /**
   * Comanda al veicolo di percorrere `waypoints`, partendo da `origin` se non lo si conosce già.
   *
   * `origin` è la posizione che il backend ha in tabella e serve **solo la prima volta**: da lì in
   * poi la posizione autorevole è quella del simulatore, che è l'unico a sapere dove il veicolo si
   * è spostato nel frattempo. Sovrascriverla a ogni comando riporterebbe indietro nel tempo un
   * veicolo la cui riga non fosse ancora stata aggiornata.
   *
   * Una rotta comandata **sostituisce** quella in corso: è così che un veicolo in avvicinamento
   * viene dirottato, ed è così che a fine corsa parte verso la destinazione del passeggero.
   */
  followRoute(robotaxiId: string, origin: GeoPoint, waypoints: readonly GeoPoint[]): void {
    const vehicle = this.vehicles.get(robotaxiId) ?? {
      position: origin,
      remaining: [],
      destination: null,
      hasArrived: false,
    };

    const destination = waypoints.at(-1) ?? null;
    vehicle.remaining = waypoints.slice();
    vehicle.destination = destination;
    // Una rotta vuota, o che finisce dove il veicolo già si trova, è arrivata prima di cominciare.
    vehicle.hasArrived = destination === null || vehicle.remaining.length === 0;

    this.vehicles.set(robotaxiId, vehicle);
  }

  /**
   * **Revoca** la rotta del veicolo: resta dov'è e non sta più andando da nessuna parte.
   *
   * È il comando che rende realizzabile la seconda metà di R14 (DD §2.6.3, decisione D27). Un
   * veicolo che si sta avvicinando al punto di ritiro non può essere dichiarato disponibile mentre
   * è ancora in strada per qualcuno: prima gli si toglie la rotta, poi lo si libera. L'ordine è
   * quello, e l'annullamento lo rispetta.
   *
   * Su un veicolo che il simulatore non conosce non fa nulla: non avendogli mai comandato una
   * rotta, non c'è niente da revocare.
   */
  revokeRoute(robotaxiId: string): void {
    const vehicle = this.vehicles.get(robotaxiId);
    if (vehicle === undefined) return;

    vehicle.remaining = [];
    vehicle.destination = null;
    vehicle.hasArrived = false;
  }

  /**
   * Un passo del mondo simulato: ogni veicolo con una rotta avanza di `speedKmH × tickMinutes`.
   *
   * Il budget di percorrenza si consuma segmento per segmento, quindi un tick lungo può
   * attraversare più punti della polyline e un tick corto fermarsi a metà di un segmento. Chi
   * arriva a destinazione smette di consumare: la strada che gli avanzava non si trasferisce alla
   * rotta successiva, che comincerà dal tick dopo.
   */
  tick(): void {
    const stepKm = (this.settings.speedKmH * this.settings.tickMinutes) / 60;

    for (const vehicle of this.vehicles.values()) {
      if (vehicle.remaining.length === 0) continue;

      let budgetKm = stepKm;
      while (budgetKm > 0 && vehicle.remaining.length > 0) {
        // `remaining` non è vuoto: il controllo del `while` lo garantisce.
        const next = vehicle.remaining[0] as GeoPoint;
        const legKm = haversineKm(vehicle.position, next);

        if (legKm <= budgetKm) {
          vehicle.position = next;
          vehicle.remaining.shift();
          budgetKm -= legKm;
          continue;
        }

        vehicle.position = interpolate(vehicle.position, next, budgetKm / legKm);
        budgetKm = 0;
      }

      if (vehicle.remaining.length === 0) vehicle.hasArrived = true;
    }
  }

  /**
   * La telemetria di tutti i veicoli conosciuti, in ordine di `id` crescente.
   *
   * L'ordine è totale e non incidentale: chi la legge muove corse e scrive righe, e due esecuzioni
   * sullo stesso stato devono produrre la stessa sequenza di scritture.
   */
  telemetry(): readonly VehicleTelemetryReading[] {
    return [...this.vehicles.keys()].sort().map((robotaxiId) => this.readingOf(robotaxiId));
  }

  /** La telemetria di un solo veicolo, o `null` se il simulatore non lo conosce. */
  reading(robotaxiId: string): VehicleTelemetryReading | null {
    return this.vehicles.has(robotaxiId) ? this.readingOf(robotaxiId) : null;
  }

  /** Dimentica tutti i veicoli. Serve a chi ricompone il simulatore fra un test e l'altro. */
  reset(): void {
    this.vehicles.clear();
  }

  private readingOf(robotaxiId: string): VehicleTelemetryReading {
    // Chiamato solo per chiavi presenti nella mappa.
    const vehicle = this.vehicles.get(robotaxiId) as SimulatedVehicle;

    let remainingKm = 0;
    let from = vehicle.position;
    for (const waypoint of vehicle.remaining) {
      remainingKm += haversineKm(from, waypoint);
      from = waypoint;
    }

    return {
      robotaxiId,
      position: vehicle.position,
      destination: vehicle.destination,
      remainingKm,
      hasArrived: vehicle.hasArrived,
    };
  }
}

/**
 * Quanti tick servono a percorrere `routeKm`.
 *
 * Esportata perché è la promessa che il cancello di M7 verifica — «il simulatore porta un veicolo
 * da `assigned` ad `arrived` in un numero deterministico di tick» — e un cancello che la
 * ricalcolasse a modo suo verificherebbe la propria aritmetica invece di quella del simulatore.
 */
export function ticksToCover(routeKm: number, settings: FleetSimulatorSettings): number {
  const stepKm = (settings.speedKmH * settings.tickMinutes) / 60;
  return Math.ceil(routeKm / stepKm);
}

/**
 * Il punto a frazione `ratio` del segmento `from → to`, interpolando le coordinate.
 *
 * Su distanze urbane l'interpolazione lineare in gradi e quella lungo l'ortodromia differiscono di
 * meno di un metro, e il simulatore non promette una posizione geodetica: promette che un veicolo
 * avanzi in modo continuo e ripetibile lungo la rotta che gli è stata data.
 */
function interpolate(from: GeoPoint, to: GeoPoint, ratio: number): GeoPoint {
  return {
    lat: from.lat + (to.lat - from.lat) * ratio,
    lon: from.lon + (to.lon - from.lon) * ratio,
  };
}
