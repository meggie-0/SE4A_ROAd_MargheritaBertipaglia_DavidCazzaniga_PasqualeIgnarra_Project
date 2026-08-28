import type { TrafficLevel } from '@road/shared';

/**
 * La sorgente del livello di traffico, dietro cui stanno due adapter (decisione D76).
 *
 * **Non è una porta**, ed è una distinzione che vale la pena tenere ferma: le porte del DD §2.2
 * sono ciò che un modulo espone agli altri, e questa classe non compare negli `exports` di
 * `ExternalModule` né in nessun import fuori da `external/`. È una giuntura **interna** al facade,
 * della stessa natura di quella fra `OsrmRouteGateway` e `LinearRouteGateway`: chi chiede
 * `ExternalServicesPort.getTraffic()` non sa — e non deve sapere — quale dei due adapter risponda.
 *
 * È esattamente ciò che NFR8 promette, esercitato invece che affermato: fino a qui la
 * sostituibilità del fornitore di traffico era dichiarata e mai messa alla prova, perché di
 * fornitori ce n'era uno solo.
 */
export abstract class TrafficSource {
  abstract getTraffic(): Promise<TrafficLevel>;
}
