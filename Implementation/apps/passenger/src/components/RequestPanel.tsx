import type { GeoPoint, RideRequestKind } from '@road/shared';

/**
 * Il pannello con cui si compone la richiesta (DD §3.1, RASD R3 e R4).
 *
 * «Lets the user set pickup and destination, choose between an immediate ride and a scheduled one,
 * and request the ride with a **single button**»: i punti si toccano sulla mappa, il tipo di corsa è
 * una coppia di alternative con l'immediata già scelta, e il pulsante è uno solo.
 *
 * **Il conto delle interazioni** (NFR6, DD §4.3). Da avvio a freddo con una sessione valida servono
 * tre tocchi: ritiro, destinazione, richiesta. La corsa immediata è il default proprio per questo —
 * fosse una scelta obbligatoria sarebbero quattro, e con il login sopra si sforerebbe. Una corsa
 * programmata ne costa due in più, ed è la variante meno frequente: è il verso giusto in cui
 * spendere il bilancio.
 */

export interface RequestPanelProps {
  readonly pickup: GeoPoint | null;
  readonly destination: GeoPoint | null;
  readonly kind: RideRequestKind;
  readonly scheduledPickup: string;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onKindChange: (kind: RideRequestKind) => void;
  readonly onScheduledPickupChange: (value: string) => void;
  readonly onReset: () => void;
  readonly onSubmit: () => void;
}

export function RequestPanel(props: RequestPanelProps): React.JSX.Element {
  const { pickup, destination, kind, scheduledPickup, busy, error } = props;

  const missingSchedule = kind === 'ADVANCE' && scheduledPickup.trim() === '';
  const ready = pickup !== null && destination !== null && !missingSchedule;

  return (
    <section className="panel request-panel">
      <div className="bottom-sheet-handle" aria-hidden="true" />

      <h2>Quale servizio scegli?</h2>

      <fieldset className="service-options">
        <legend className="visually-hidden">Scegli il tipo di corsa</legend>

        <label className={`service-card ${kind === 'IMMEDIATE' ? 'service-card--selected' : ''}`}>
          <input
            className="service-radio"
            type="radio"
            name="ride-kind"
            data-testid="kind-immediate"
            checked={kind === 'IMMEDIATE'}
            onChange={() => props.onKindChange('IMMEDIATE')}
          />

          <span className="service-icon" aria-hidden="true">
            <span className="road-taxi-icon" />
          </span>

          <span className="service-copy">
            <strong>Corsa immediata</strong>
            <small>Parti appena viene assegnato un robotaxi</small>
          </span>

          <span className="service-check" aria-hidden="true">
          </span>
        </label>

        <label className={`service-card ${kind === 'ADVANCE' ? 'service-card--selected' : ''}`}>
          <input
            className="service-radio"
            type="radio"
            name="ride-kind"
            data-testid="kind-advance"
            checked={kind === 'ADVANCE'}
            onChange={() => props.onKindChange('ADVANCE')}
          />

          <span className="service-icon" aria-hidden="true">
            <svg
              viewBox="0 0 48 48"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="12" width="30" height="27" rx="4" />
              <path d="M16 8v8M32 8v8M9 21h30" />
              <path d="M16 27h4M24 27h4M32 27h1" />
              <path d="M16 33h4M24 33h4" />
            </svg>
          </span>

          <span className="service-copy">
            <strong>Programma corsa</strong>
            <small>Scegli in anticipo data e ora del ritiro</small>
          </span>

          <span className="service-check" aria-hidden="true">
          </span>
        </label>
      </fieldset>

      {kind === 'ADVANCE' && (
        <label className="schedule mobile-schedule">
          Data e ora del ritiro
          <input
            type="datetime-local"
            data-testid="scheduled-pickup"
            value={scheduledPickup}
            onChange={(event) => props.onScheduledPickupChange(event.target.value)}
            required
          />
        </label>
      )}

      <div className="route-summary">
        <p className="hint" data-testid="pick-hint">
          {pickup === null
            ? 'Seleziona il punto di partenza sulla mappa.'
            : destination === null
              ? 'Ora seleziona la destinazione sulla mappa.'
              : 'Percorso impostato correttamente.'}
        </p>

        <dl className="points">
          <dt>Partenza</dt>
          <dd data-testid="pickup-value">{pickup === null ? '—' : formatPoint(pickup)}</dd>

          <dt>Arrivo</dt>
          <dd data-testid="destination-value">
            {destination === null ? '—' : formatPoint(destination)}
          </dd>
        </dl>
      </div>

      {error !== null && (
        <p className="status-error" data-testid="request-error" role="alert">
          {error}
        </p>
      )}

      <div className="request-actions">
        <button
          type="button"
          className="booking-button"
          data-testid="request-ride"
          disabled={!ready || busy}
          onClick={props.onSubmit}
        >
          {busy ? 'Prenotazione in corso…' : 'Prenota corsa'}
        </button>

        <button
          type="button"
          className="link-button reset-route-button"
          data-testid="reset-points"
          onClick={props.onReset}
          disabled={pickup === null && destination === null}
        >
          Azzera il percorso
        </button>
      </div>
    </section>
  );
}

/** Coordinate leggibili: quattro decimali sono circa undici metri, che su una città bastano. */
function formatPoint(point: GeoPoint): string {
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
}
