import { haversineKm, type GeoPoint, type TrafficLevel } from '@road/shared';
import { SLOWDOWN_SAMPLE_KM, type Slowdown } from '@road/simulator';

import { TrafficSource } from './traffic-source';

/** Quanto costa, in tempo, un chilometro a ciascun livello di traffico (decisione D79). */
export type TrafficTimeFactors = Readonly<Record<TrafficLevel, number>>;

/**
 * Il traffico **nel mondo**: quanto rallenta i veicoli, e quindi quanto allunga le stime (D79).
 *
 * Fino a v1.13 il traffico era un'etichetta. Commutava la strategia, ma né il simulatore né le stime
 * lo leggevano: una macchina impiegava lo stesso tempo con traffico basso o altissimo, e la
 * strategia a ETA minimo sceglieva sempre il veicolo più vicino — misurato, zero assegnazioni
 * diverse su cinquantuno. Il sistema commutava per una ragione che nel suo mondo non accadeva mai.
 *
 * Questa classe è la fisica che mancava, ed è **una sola** per le due metà che ne dipendono: il
 * simulatore rallenta un veicolo secondo il punto in cui si trova (`slowdownForSimulator`), e il
 * facade allunga ogni stima secondo la strada che il veicolo dovrà fare (`routeFactor`). Tenerle in
 * due posti permetterebbe loro di divergere, e una stima che promette un tempo che il simulatore non
 * mantiene è un numero falso sul registro dell'operatore.
 *
 * **Non è una porta** e non esce da `external`: il livello per zona è un fatto del mondo, e il resto
 * del sistema continua a leggere un livello solo, attraverso `getTraffic()`.
 *
 * **Senza fattori configurati non fa nulla**, e non per aritmetica: `routeFactor` restituisce
 * esattamente `1` senza campionare niente, e il simulatore non riceve alcuna funzione, quindi
 * percorre il ciclo di sempre. Un'installazione che ignora `TRAFFIC_TIME_FACTORS` si comporta come
 * prima, tick per tick.
 */
export class TrafficSlowdown {
  constructor(
    private readonly traffic: TrafficSource,
    private readonly factors: TrafficTimeFactors | null,
  ) {}

  /** Il fattore nel punto: quello del livello di traffico che c'è lì. */
  factorAt(point: GeoPoint): number {
    if (this.factors === null) return 1;
    return this.factors[this.traffic.levelAt(point)];
  }

  /**
   * Il fattore medio **lungo il tragitto** da `from` a `to`: la regola della D79.
   *
   * La linea si spezza nei tratti che usa il simulatore, e ogni tratto pesa per il fattore del suo
   * punto medio. È l'unica delle regole provate che sia coerente con il simulatore, che rallenta un
   * veicolo secondo dove si trova a ogni passo. Le alternative, misurate sulla flotta del seed con
   * 712 prelievi in centro e il centro a `HIGH`:
   *
   * - **la zona del prelievo** non cambia mai il vincitore — zero casi su 712 — perché moltiplica
   *   tutti i candidati per lo stesso numero;
   * - **la zona del veicolo** lo cambia in un caso su tre, ma promettendo tempi falsi: un'auto di
   *   periferia verrebbe stimata veloce per tutto il tragitto, e il simulatore la rallenterebbe appena
   *   entra in centro.
   *
   * La linea è **retta** anche quando le mappe sono di OSRM, perché la matrice dei tempi non porta la
   * geometria: per un fornitore stradale è un'approssimazione, per la stima in linea d'aria è
   * esattamente il percorso che il simulatore farà.
   */
  routeFactor(from: GeoPoint, to: GeoPoint): number {
    if (this.factors === null) return 1;

    const pieces = Math.max(1, Math.ceil(haversineKm(from, to) / SLOWDOWN_SAMPLE_KM));
    let total = 0;
    for (let piece = 0; piece < pieces; piece += 1) {
      const ratio = (piece + 0.5) / pieces;
      total += this.factorAt({
        lat: from.lat + (to.lat - from.lat) * ratio,
        lon: from.lon + (to.lon - from.lon) * ratio,
      });
    }
    return total / pieces;
  }

  /** La funzione da dare al simulatore, o `undefined` perché percorra il ciclo di sempre. */
  slowdownForSimulator(): Slowdown | undefined {
    if (this.factors === null) return undefined;
    return (position) => this.factorAt(position);
  }
}
