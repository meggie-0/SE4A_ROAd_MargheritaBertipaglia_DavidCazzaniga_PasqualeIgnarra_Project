import type { GeoPoint, TrafficLevel } from '@road/shared';

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
  /**
   * Il livello che il sistema **legge**: uno solo, quello su cui il `ModeController` decide.
   *
   * Con il traffico per zona della D79 è il livello del **centro**, che è dove la commutazione
   * della strategia ha senso: è lì che il veicolo più vicino smette di essere il più veloce.
   */
  abstract getTraffic(): Promise<TrafficLevel>;

  /**
   * Il livello **in un punto** della città, per chi rallenta i veicoli e allunga le stime (D79).
   *
   * Non esce da `external`: il resto del sistema non sa che il traffico ha un dettaglio per zona, e
   * non deve saperlo — la strategia attiva è una per la città, quindi una soglia per zona non
   * avrebbe niente da comandare (`ExternalServicesPort.getTraffic`).
   */
  abstract levelAt(point: GeoPoint): TrafficLevel;
}
