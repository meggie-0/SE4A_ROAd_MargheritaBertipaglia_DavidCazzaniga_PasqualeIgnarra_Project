import { Injectable } from '@nestjs/common';
import { TRAFFIC_LEVELS, type TrafficLevel } from '@road/shared';

import { ClockPort } from '../platform/clock.port';

import { TrafficSource } from './traffic-source';

/**
 * La sorgente di traffico **pilotabile**: una tabella oraria relativa all'avvio del processo
 * (decisione D76).
 *
 * `HourlyTrafficGateway` deduce il livello dall'ora locale di Milano, il che è la cosa giusta per un
 * sistema acceso — ma non è pilotabile in nessun modo: per vedere la sequenza `LOW → MEDIUM → HIGH`
 * bisogna presentarsi alle 17:00 di un giorno feriale, e comunque non a comando. Lo scenario 3 del
 * RASD, che è quello dell'isteresi e del rientro in Auto, non era quindi dimostrabile affatto.
 *
 * Questo adapter segue una tabella come `LOW:0,MEDIUM:30,HIGH:60,MEDIUM:90,LOW:120` — livello e
 * secondi trascorsi dall'avvio — e svolge l'intera sequenza in due minuti, in modo deterministico e
 * ripetibile.
 *
 * **Perché un secondo adapter e non una modifica al primo.** `hourly-traffic.gateway.ts` dice di sé
 * di essere «il mock del fornitore di traffico» e «un'assunzione dichiarata del prototipo»:
 * affiancargliene un altro non lo degrada, e non gli toglie il posto in esecuzione normale, dove
 * resta il default. È lo stesso schema che `external` usa già per i percorsi, con `OsrmRouteGateway`
 * e `LinearRouteGateway` scelti dietro la porta a seconda della configurazione.
 *
 * **Il mondo è diverso in dimostrazione, non la macchina.** È la ragione per cui questa è la forma
 * corretta e una rotta `POST /demo/traffic` non lo sarebbe: il traffico è un fenomeno **del mondo**,
 * osservato dalla macchina, e la phenomena table del RASD §1.2 lo classifica così applicando
 * Jackson. Una rotta che lo *imposta* lo renderebbe un fenomeno controllato dalla macchina, cioè
 * capovolgerebbe la classificazione su cui il documento si regge.
 *
 * Determinismo (CLAUDE.md Regola 3): l'unico ingresso è `ClockPort.now()`. Nessun timer, nessuna
 * casualità, nessuna rete — due letture nello stesso istante simulato danno lo stesso livello.
 */

/** Un gradino della tabella: da `fromSecond` secondi dopo l'avvio, il livello è questo. */
interface ScriptStep {
  readonly fromSecond: number;
  readonly level: TrafficLevel;
}

/** La tabella usata quando `TRAFFIC_SCRIPT` è assente o illeggibile: la sequenza dello scenario 3. */
export const DEFAULT_TRAFFIC_SCRIPT = 'LOW:0,MEDIUM:30,HIGH:60,MEDIUM:90,LOW:120';

/**
 * Traduce la tabella scritta nell'ambiente, scartando ciò che non si capisce.
 *
 * **Scarta invece di sollevare**, e non per indulgenza: questo adapter si attiva solo in
 * dimostrazione, e un refuso in una variabile d'ambiente che impedisse l'avvio dell'API
 * trasformerebbe un errore di battitura in una demo che non parte davanti a chi guarda. Un gradino
 * illeggibile viene ignorato; se non ne resta nessuno si ricade sulla tabella di default, che è la
 * sequenza che lo scenario 3 racconta.
 */
function parseTrafficScript(raw: string): readonly ScriptStep[] {
  const steps = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .flatMap((entry): ScriptStep[] => {
      const [levelPart = '', secondPart = ''] = entry.split(':');
      const level = levelPart.trim().toUpperCase();
      const fromSecond = Number.parseInt(secondPart.trim(), 10);

      if (!(TRAFFIC_LEVELS as readonly string[]).includes(level)) return [];
      if (!Number.isFinite(fromSecond) || fromSecond < 0) return [];

      return [{ level: level as TrafficLevel, fromSecond }];
    });

  // In ordine crescente di istante: la lettura qui sotto prende l'ultimo gradino già scaduto, e su
  // una tabella disordinata prenderebbe quello sbagliato. I pareggi tengono l'ultimo scritto.
  return [...steps].sort((a, b) => a.fromSecond - b.fromSecond);
}

@Injectable()
export class ScriptedTrafficGateway extends TrafficSource {
  private readonly steps: readonly ScriptStep[];

  /**
   * L'istante dell'avvio, preso una volta sola.
   *
   * La tabella è **relativa all'avvio del processo** e non a un orario assoluto: così lo stesso
   * comando di dimostrazione racconta la stessa storia a qualunque ora venga eseguito, che è ciò
   * che serve perché la demo sia riproducibile da terzi.
   */
  private readonly startedAt: Date;

  constructor(
    private readonly clock: ClockPort,
    script: string,
  ) {
    super();
    const parsed = parseTrafficScript(script);
    this.steps = parsed.length > 0 ? parsed : parseTrafficScript(DEFAULT_TRAFFIC_SCRIPT);
    this.startedAt = this.clock.now();
  }

  getTraffic(): Promise<TrafficLevel> {
    const elapsedSeconds = (this.clock.now().getTime() - this.startedAt.getTime()) / 1000;

    /**
     * L'ultimo gradino già scaduto, e la tabella **non si ripete**.
     *
     * Oltre l'ultimo gradino il livello resta quello: una tabella ciclica farebbe ricominciare la
     * sequenza mentre l'operatore la sta ancora guardando, e una dimostrazione che riparte da sola
     * è indistinguibile da un sistema che oscilla — che è precisamente il difetto che l'isteresi di
     * NFR9 esiste per escludere.
     *
     * Prima del primo gradino vale il primo: una tabella che comincia a `30` non lascia scoperti i
     * primi trenta secondi con un livello indefinito.
     */
    const current =
      [...this.steps].reverse().find((step) => elapsedSeconds >= step.fromSecond) ?? this.steps[0];

    // `steps` non è mai vuoto: il costruttore ricade sulla tabella di default.
    return Promise.resolve((current as ScriptStep).level);
  }
}
