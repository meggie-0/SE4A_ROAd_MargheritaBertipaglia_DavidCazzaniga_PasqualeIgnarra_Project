import type { GeoPoint } from '@road/shared';

type RoutePoint = 'pickup' | 'destination';

export interface RoutePickerPanelProps {
  readonly pickup: GeoPoint | null;
  readonly destination: GeoPoint | null;
  readonly activePoint: RoutePoint;
  readonly onActivePointChange: (point: RoutePoint) => void;
}

export function RoutePickerPanel(props: RoutePickerPanelProps): React.JSX.Element {
  return (
    <section
      id="route-search-dropdown"
      className="panel route-search-dropdown"
      aria-label="Imposta il percorso"
    >
      <div className="route-point-selector">
        <button
          type="button"
          className={`route-point-button ${
            props.activePoint === 'pickup' ? 'route-point-button--active' : ''
          }`}
          data-testid="select-pickup"
          aria-pressed={props.activePoint === 'pickup'}
          onClick={() => props.onActivePointChange('pickup')}
        >
          <span className="route-point-marker route-point-marker--pickup" aria-hidden="true" />

          <span className="route-point-copy">
            <small>Partenza</small>
            <strong>
              {props.pickup === null ? 'Seleziona sulla mappa' : formatPoint(props.pickup)}
            </strong>
          </span>
        </button>

        <button
          type="button"
          className={`route-point-button ${
            props.activePoint === 'destination' ? 'route-point-button--active' : ''
          }`}
          data-testid="select-destination"
          aria-pressed={props.activePoint === 'destination'}
          onClick={() => props.onActivePointChange('destination')}
        >
          <span className="route-point-marker route-point-marker--destination" aria-hidden="true" />

          <span className="route-point-copy">
            <small>Destinazione</small>
            <strong>
              {props.destination === null
                ? 'Seleziona sulla mappa'
                : formatPoint(props.destination)}
            </strong>
          </span>
        </button>
      </div>

      <p className="route-picker-hint">
        {props.activePoint === 'pickup'
          ? 'Tocca la mappa per impostare il punto di partenza.'
          : 'Tocca la mappa per impostare la destinazione.'}
      </p>
    </section>
  );
}

function formatPoint(point: GeoPoint): string {
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
}
