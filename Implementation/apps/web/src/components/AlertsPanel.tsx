import type { AlertEntry } from '../operator-alerts';

/**
 * Il pannello degli alert (DD §3.2: «pannello alert per switch automatici e suggerimenti di
 * rebalancing»; RASD R11, R12, R13; G9).
 *
 * Mostra **solo** gli eventi che riguardano il governo del sistema, non tutto ciò che passa sul
 * canale: un veicolo che arriva a un ritiro è un fatto di flotta e si vede sulla mappa e nel log
 * operativo, mentre uno switch automatico di strategia è una decisione che il sistema ha preso al
 * posto dell'operatore, e quella va detta a parole.
 *
 * **[D77] Le righe hanno una storia.** Fino a qui il pannello viveva della sola memoria della
 * scheda: ricaricare la pagina lo svuotava, e chi apriva la dashboard dopo un riposizionamento
 * trovava un sistema che dichiarava di non aver fatto niente. Adesso le due sorgenti sono fuse in
 * `mergeOperatorAlerts()` — lo storico riletto da `GET /notifications/operator` e ciò che arriva
 * dalla socket — e il pannello non sa più da quale delle due venga una riga, che è esattamente
 * quanto deve sapere.
 */

export interface AlertsPanelProps {
  readonly alerts: readonly AlertEntry[];
  /** Distingue «non è successo niente» da «non l'ho ancora chiesto»: sono due schermate diverse. */
  readonly loading: boolean;
}

export function AlertsPanel({ alerts, loading }: AlertsPanelProps): React.JSX.Element {
  return (
    <section className="panel alerts-panel">
      <h2>Alert</h2>

      {alerts.length === 0 ? (
        <p className="muted" data-testid="alerts-empty">
          {loading
            ? 'Lettura degli alert in corso…'
            : 'Nessun alert. Gli switch automatici di strategia e i riposizionamenti compaiono qui.'}
        </p>
      ) : (
        <ul className="alerts" data-testid="alerts">
          {alerts.map((alert) => (
            <li key={`${alert.occurredAt}-${alert.message}`} className={`alert ${alert.category}`}>
              <span className="alert-time">{formatTime(alert.occurredAt)}</span>
              <span className="alert-message">{alert.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Solo l'orario: la data di un alert di pochi minuti fa è rumore. */
function formatTime(isoInstant: string): string {
  return new Date(isoInstant).toLocaleTimeString('it-IT');
}
