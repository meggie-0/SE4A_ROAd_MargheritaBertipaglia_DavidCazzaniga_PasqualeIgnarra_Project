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
      <h2>Richiedi una corsa</h2>

      <p className="hint" data-testid="pick-hint">
        {pickup === null
          ? 'Tocca la mappa per indicare dove vuoi essere prelevato.'
          : destination === null
            ? 'Ora tocca la mappa per indicare la destinazione.'
            : 'Ritiro e destinazione impostati.'}
      </p>

      <dl className="points">
        <dt>Ritiro</dt>
        <dd data-testid="pickup-value">{pickup === null ? '—' : formatPoint(pickup)}</dd>
        <dt>Destinazione</dt>
        <dd data-testid="destination-value">
          {destination === null ? '—' : formatPoint(destination)}
        </dd>
      </dl>

      {/* Due alternative esclusive, con l'immediata preselezionata: è la scelta che il RASD §2.4
          descrive, e non un menù a tendina che costerebbe un'interazione in più. */}
      <fieldset className="kind">
        <legend>Quando</legend>
        <label>
          <input
            type="radio"
            name="ride-kind"
            data-testid="kind-immediate"
            checked={kind === 'IMMEDIATE'}
            onChange={() => props.onKindChange('IMMEDIATE')}
          />
          Subito
        </label>
        <label>
          <input
            type="radio"
            name="ride-kind"
            data-testid="kind-advance"
            checked={kind === 'ADVANCE'}
            onChange={() => props.onKindChange('ADVANCE')}
          />
          Programmata
        </label>
      </fieldset>

      {kind === 'ADVANCE' && (
        <label className="schedule">
          Orario di ritiro
          <input
            type="datetime-local"
            data-testid="scheduled-pickup"
            value={scheduledPickup}
            onChange={(event) => props.onScheduledPickupChange(event.target.value)}
            required
          />
        </label>
      )}

      {error !== null && (
        <p className="status-error" data-testid="request-error" role="alert">
          {error}
        </p>
      )}

      <div className="actions">
        <button
          type="button"
          data-testid="request-ride"
          disabled={!ready || busy}
          onClick={props.onSubmit}
        >
          {busy ? 'Invio…' : kind === 'IMMEDIATE' ? 'Richiedi corsa' : 'Prenota corsa'}
        </button>
        <button
          type="button"
          className="link-button"
          data-testid="reset-points"
          onClick={props.onReset}
          disabled={pickup === null && destination === null}
        >
          Azzera i punti
        </button>
      </div>
    </section>
  );
}

/** Coordinate leggibili: quattro decimali sono circa undici metri, che su una città bastano. */
function formatPoint(point: GeoPoint): string {
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`;
}
