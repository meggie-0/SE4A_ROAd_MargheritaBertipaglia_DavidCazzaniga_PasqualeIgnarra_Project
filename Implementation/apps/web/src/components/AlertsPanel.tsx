import type { NotificationPush } from '@road/shared';

/**
 * Il pannello degli alert (DD §3.2: «pannello alert per switch automatici e suggerimenti di
 * rebalancing»; RASD R11, R12; G9).
 *
 * Mostra **solo** gli eventi che riguardano il governo del sistema, non tutto ciò che passa sul
 * canale: un veicolo che arriva a un ritiro è un fatto di flotta e si vede sulla mappa, mentre uno
 * switch automatico di strategia è una decisione che il sistema ha preso al posto dell'operatore, e
 * quella va detta a parole.
 *
 * I quattro campi strutturati che M6 ha aggiunto alla notifica — `strategy`, `mode`, `trafficLevel`,
 * `zoneId` — servono esattamente a questo: permettono di *classificare* un evento invece di cercare
 * parole dentro `message`, che è testo per un umano e cambierebbe significato alla prima
 * riformulazione.
 */

export interface AlertsPanelProps {
  readonly notifications: readonly NotificationPush[];
}

/** Quanti alert mostrare: oltre, l'elenco smette di essere leggibile a colpo d'occhio. */
const VISIBLE_ALERTS = 12;

export function AlertsPanel({ notifications }: AlertsPanelProps): React.JSX.Element {
  // Gli alert dal più recente: chi guarda una console vuole sapere cos'è appena successo.
  const alerts = notifications.filter(isAlert).slice(-VISIBLE_ALERTS).reverse();

  return (
    <section className="panel alerts-panel">
      <h2>Alert</h2>

      {alerts.length === 0 ? (
        <p className="muted" data-testid="alerts-empty">
          Nessun alert. Gli switch automatici di strategia e i riposizionamenti compaiono qui.
        </p>
      ) : (
        <ul className="alerts" data-testid="alerts">
          {alerts.map((alert, index) => (
            <li key={`${alert.occurredAt}-${index}`} className={`alert ${categoryOf(alert)}`}>
              <span className="alert-time">{formatTime(alert.occurredAt)}</span>
              <span className="alert-message">{alert.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Un evento è un alert per l'operatore se parla di traffico, di modo, di strategia o di
 * riposizionamento.
 *
 * `REBALANCING_ALERT` è l'unico tipo dell'enum del RASD che riguarda l'operatore; gli altri quattro
 * sono notifiche al passeggero e non hanno niente da fare qui. Gli eventi di modo arrivano con
 * `type: null` e si riconoscono dai campi strutturati (decisione D42).
 */
function isAlert(event: NotificationPush): boolean {
  if (event.type === 'REBALANCING_ALERT') return true;
  return event.trafficLevel !== null || event.mode !== null || event.strategy !== null;
}

function categoryOf(event: NotificationPush): string {
  if (event.type === 'REBALANCING_ALERT') return 'rebalancing';
  if (event.trafficLevel === 'HIGH') return 'high';
  if (event.trafficLevel === 'MEDIUM') return 'medium';
  return 'mode';
}

/** Solo l'orario: la data di un alert di pochi minuti fa è rumore. */
function formatTime(isoInstant: string): string {
  return new Date(isoInstant).toLocaleTimeString('it-IT');
}
