import type { NotificationPush } from '@road/shared';

import { STATE_APPEARANCE } from '../robotaxi-states';
import { TRAFFIC_APPEARANCE } from '../traffic-levels';

/**
 * Il **log operativo**: la finestra dal vivo su ciò che la flotta sta facendo (DD §3.2; R7, G8).
 *
 * Resta separato dal pannello alert, e la distinzione è quella che la decisione D77 rende netta.
 * Qui scorrono le **transizioni dei veicoli** — un fatto per tick, che si guarda mentre accade e non
 * si rilegge: la stessa progressione è visibile sulla mappa, e persisterla significherebbe scrivere
 * migliaia di righe per rivedere ciò che nessuno rivede. Là stanno le decisioni di **governo**, che
 * sono poche, rare, e hanno una storia.
 *
 * Per questo il log vive della sola memoria della scheda e riparte vuoto: non è un difetto, è ciò
 * che è. Chi cerca «cosa ha deciso il sistema mentre non c'ero» guarda il pannello alert.
 */

interface OperationalLogProps {
  readonly notifications: readonly NotificationPush[];
  readonly onFocusRobotaxi: (robotaxiId: string) => void;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('it-IT', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

const MODE_LABEL: Record<NonNullable<NotificationPush['mode']>, string> = {
  AUTO: 'Auto',
  MANUAL: 'Manual',
};

const STRATEGY_LABEL: Record<NonNullable<NotificationPush['strategy']>, string> = {
  NEAREST_AVAILABLE: 'Più vicino disponibile',
  MINIMUM_ETA: 'ETA minimo',
};

/**
 * Che cosa dire di un evento.
 *
 * **Il messaggio del backend viene per primo**, e non è una preferenza di stile: `notification-copy.ts`
 * lo compone apposta, in italiano, con il contesto che qui non c'è — quale strategia resta attiva,
 * verso quale zona un veicolo si sta muovendo, che cosa il sistema suggerisce senza applicarlo.
 * Ricostruirlo dai campi strutturati produceva una frase peggiore di quella già disponibile, e per
 * giunta una seconda traduzione da tenere allineata a mano.
 *
 * I campi strutturati restano il ripiego per gli eventi che un testo non ce l'hanno — le transizioni
 * di stato, che il canale porta senza prosa perché la loro sede è la mappa.
 */
function describeEvent(event: NotificationPush): string {
  if (event.message.trim().length > 0) return event.message;

  // Le etichette vengono da `robotaxi-states.ts`, che è l'unica sede di colore e nome di uno stato:
  // riscriverle qui significherebbe che la mappa e il log possono chiamare lo stesso stato in due
  // modi. Nessun ramo `default`: lo `switch` implicito del `Record` è esaustivo, quindi l'ottavo
  // stato non compilerebbe invece di comparire come sigla grezza.
  if (event.robotaxiState !== null) return `Stato → ${STATE_APPEARANCE[event.robotaxiState].label}`;
  if (event.mode !== null) return `Modo → ${MODE_LABEL[event.mode]}`;
  if (event.strategy !== null) return `Strategia → ${STRATEGY_LABEL[event.strategy]}`;
  if (event.trafficLevel !== null)
    return `Traffico → ${TRAFFIC_APPEARANCE[event.trafficLevel].label}`;
  if (event.zoneId !== null) return `Riposizionamento verso ${event.zoneId}`;

  return 'Evento di sistema';
}

export function OperationalLog({
  notifications,
  onFocusRobotaxi,
}: OperationalLogProps): React.JSX.Element {
  const events = [...notifications].reverse();

  return (
    <section className="panel operational-log" aria-label="Log operativo">
      <div className="operational-log-heading">
        <h2>Log operativo</h2>
        <span>Ultimi {events.length} eventi</span>
      </div>

      {events.length === 0 ? (
        <p className="operational-log-empty">In attesa di eventi operativi…</p>
      ) : (
        <div className="operational-log-list">
          {events.map((event, index) => (
            <div
              key={`${event.occurredAt}-${event.type ?? 'event'}-${index}`}
              className="operational-log-row"
            >
              <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>

              {event.robotaxiId !== null ? (
                <button
                  type="button"
                  className="operational-log-robotaxi"
                  aria-label={`Mostra ${event.robotaxiId} sulla mappa`}
                  onClick={() => onFocusRobotaxi(event.robotaxiId!)}
                >
                  {event.robotaxiId}
                </button>
              ) : (
                <strong className="operational-log-system">Sistema</strong>
              )}

              <span>{describeEvent(event)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
