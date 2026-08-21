import type { NotificationPush } from '@road/shared';

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

function formatRobotaxiState(state: NonNullable<NotificationPush['robotaxiState']>): string {
  switch (state) {
    case 'AVAILABLE':
      return 'Disponibile';
    case 'ASSIGNED':
      return 'Assegnato';
    case 'ARRIVING':
      return 'In avvicinamento';
    case 'ARRIVED':
      return 'Al ritiro';
    case 'IN_RIDE':
      return 'In corsa';
    case 'REBALANCING':
      return 'In riposizionamento';
    case 'MAINTENANCE':
      return 'In manutenzione';
    default:
      return state;
  }
}

function describeEvent(event: NotificationPush): string {
  if (event.robotaxiState !== null) {
    return `Stato → ${formatRobotaxiState(event.robotaxiState)}`;
  }

  if (event.mode !== null) {
    return `Modalità operativa → ${event.mode}`;
  }

  if (event.strategy !== null) {
    return `Strategia di allocazione → ${event.strategy}`;
  }

  if (event.trafficLevel !== null) {
    return `Traffico → ${event.trafficLevel}`;
  }

  if (event.zoneId !== null) {
    return `Evento zona → ${event.zoneId}`;
  }

  if (event.message.trim().length > 0) {
    return event.message;
  }

  return event.type ?? 'Evento di sistema';
}

export function OperationalLog({
  notifications,
  onFocusRobotaxi,
}: OperationalLogProps): React.JSX.Element {
  const events = [...notifications].slice(-40).reverse();

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
