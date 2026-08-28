import { Injectable } from '@nestjs/common';
import { isWeekend, milanWeekdayHourSlot, type TrafficLevel } from '@road/shared';

import { ClockPort } from '../platform/clock.port';

import { TrafficSource } from './traffic-source';

/**
 * L'adapter della sorgente di traffico di M6: il livello **dedotto dall'ora locale di Milano**.
 *
 * MILESTONES.md tiene i sistemi esterni su mock fino a M7, e questo è il mock del fornitore di
 * traffico. Come la stima lineare degli ETA, non è un doppio da test lasciato in produzione: è la
 * curva oraria che qualunque servizio di traffico urbano riproduce a grandi linee, ed è ciò che
 * permette di vedere R12 funzionare su un sistema acceso senza dover cambiare una variabile
 * d'ambiente a mano.
 *
 * **È un'assunzione dichiarata del prototipo**, come `AVERAGE_URBAN_SPEED_KMH`: il RASD §2.6 tratta
 * il servizio di mappe come dipendenza esterna, e finché M7 non collega un fornitore vero questa
 * classe lo sostituisce. Quando arriverà, sostituirla non toccherà una riga di `mode`, che conosce
 * solo `ExternalServicesPort` (NFR8).
 *
 * **[D76]** Da qui in avanti è uno dei **due** adapter dietro `TrafficSource`, e resta il default:
 * l'altro segue una tabella oraria e serve a rendere dimostrabile lo scenario 3. Questa classe non
 * cambia comportamento.
 *
 * Determinismo (CLAUDE.md Regola 3): l'unico ingresso è `ClockPort.now()`. Non c'è `new Date()`,
 * non c'è casualità, non c'è rete — due letture nello stesso istante simulato danno lo stesso
 * livello, che è ciò che rende ripetibili i test sull'isteresi.
 */

/**
 * Le ore di punta feriali: due in entrata la mattina, tre in uscita la sera.
 *
 * L'asimmetria è quella vera di Milano — l'uscita è più distribuita dell'entrata — ma il valore
 * esatto conta poco: ciò che il sistema usa è la **soglia**, non il numero di ore che la superano.
 */
const WEEKDAY_RUSH_HOURS: readonly number[] = [7, 8, 17, 18, 19];

/** Le ore che costeggiano le punte: trafficate ma non congestionate. */
const WEEKDAY_BUSY_HOURS: readonly number[] = [6, 9, 10, 16, 20];

/**
 * Nel fine settimana non ci sono punte pendolari: resta la sera.
 *
 * Il livello si ferma a `MEDIUM`, che è la soglia con cui R12 **avvisa senza commutare**. È
 * coerente col resto del modello: il sabato sera la città è piena, ma non è la congestione che
 * giustifica di allocare a tempo di arrivo invece che a distanza.
 */
const WEEKEND_BUSY_HOURS: readonly number[] = [19, 20, 21, 22];

@Injectable()
export class HourlyTrafficGateway extends TrafficSource {
  constructor(private readonly clock: ClockPort) {
    super();
  }

  getTraffic(): Promise<TrafficLevel> {
    const slot = milanWeekdayHourSlot(this.clock.now());

    if (isWeekend(slot)) {
      return Promise.resolve(WEEKEND_BUSY_HOURS.includes(slot.hourOfDay) ? 'MEDIUM' : 'LOW');
    }

    if (WEEKDAY_RUSH_HOURS.includes(slot.hourOfDay)) return Promise.resolve('HIGH');
    if (WEEKDAY_BUSY_HOURS.includes(slot.hourOfDay)) return Promise.resolve('MEDIUM');
    return Promise.resolve('LOW');
  }
}
