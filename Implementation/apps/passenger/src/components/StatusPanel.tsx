import type { RideRequestResponse } from '@road/shared';
import { useState } from 'react';
import { PHASE_LABELS, type RidePhase, type RideView } from '../ride-phase';

/**
 * La vista di stato live (DD §3.1, RASD R6 e G7).
 *
 * «After the request, the **same screen** turns into a live status view»: questo pannello prende il
 * posto di `RequestPanel` sulla stessa mappa, e non è una pagina nuova — la mappa resta dov'era, con
 * ritiro e destinazione ancora visibili.
 *
 * **Non interroga il backend.** Tutto ciò che mostra arriva dal canale push, che è la condizione con
 * cui il DD §4.3 dichiara soddisfatto NFR2: se questo pannello dovesse ri-chiedere lo stato per
 * accorgersi di un cambiamento, il requisito sarebbe violato dal client anche con un backend
 * perfetto.
 *
 * `data-phase` porta il valore grezzo accanto all'etichetta italiana: è ciò su cui il test di
 * sistema asserisce, e asserire su una frase renderebbe il test ostaggio della sua traduzione.
 */

export interface StatusPanelProps {
  readonly request: RideRequestResponse;
  readonly view: RideView;
  readonly connected: boolean;
  readonly onNewRequest: () => void;
  readonly cancelling: boolean;
  readonly cancellationError: string | null;
  readonly onCancel: () => void;
}

/** Le cinque fasi che il DD §3.1 elenca, in ordine: è la barra di avanzamento della corsa. */
const PROGRESSION: readonly RidePhase[] = [
  'searching',
  'assigned',
  'arriving',
  'arrived',
  'in_ride',
];

export function StatusPanel({
  request,
  view,
  connected,
  cancelling,
  cancellationError,
  onCancel,
  onNewRequest,
}: StatusPanelProps): React.JSX.Element {
  const finished = view.phase === 'completed' || view.phase === 'cancelled';
  const [confirmingCancellation, setConfirmingCancellation] = useState(false);
  const cancellable = ['searching', 'assigned', 'arriving', 'arrived'].includes(view.phase);
  const reached = PROGRESSION.indexOf(view.phase);

  return (
    <section className="panel status-panel">
      <h2>La tua corsa</h2>

      <p className="phase" data-testid="ride-phase" data-phase={view.phase} role="status">
        {PHASE_LABELS[view.phase]}
      </p>

      {view.etaMinutes !== null && (
        <p className="eta" data-testid="ride-eta">
          Arrivo stimato fra {view.etaMinutes} min
        </p>
      )}

      {!finished && view.phase !== 'rejected' && (
        <ol className="progression">
          {PROGRESSION.map((phase, index) => (
            <li
              key={phase}
              className={index <= reached ? 'reached' : 'pending'}
              aria-current={phase === view.phase ? 'step' : undefined}
            >
              {PHASE_LABELS[phase]}
            </li>
          ))}
        </ol>
      )}

      <dl className="points">
        <dt>Richiesta</dt>
        <dd data-testid="ride-request-id">{request.id}</dd>
        <dt>Tipo</dt>
        <dd>{request.kind === 'IMMEDIATE' ? 'Immediata' : 'Programmata'}</dd>
        {request.scheduledPickup !== null && (
          <>
            <dt>Orario</dt>
            <dd>{new Date(request.scheduledPickup).toLocaleString('it-IT')}</dd>
          </>
        )}
        <dt>Robotaxi</dt>
        <dd data-testid="ride-robotaxi">{view.robotaxiId ?? '—'}</dd>
      </dl>

      {view.lastMessage !== null && (
        <p className="last-message" data-testid="ride-message">
          {view.lastMessage}
        </p>
      )}

      {cancellable && (
        <div className="cancellation-actions">
          <button
            type="button"
            className="danger-button"
            data-testid="cancel-ride"
            disabled={cancelling}
            onClick={() => setConfirmingCancellation(true)}
          >
            {cancelling ? 'Annullamento in corso…' : 'Annulla corsa'}
          </button>

          <p className="muted">Puoi annullare gratuitamente fino all’inizio della corsa.</p>
        </div>
      )}

      {cancellationError !== null && (
        <p className="status-error" data-testid="cancellation-error" role="alert">
          {cancellationError}
        </p>
      )}

      {confirmingCancellation && (
        <div className="confirmation-overlay">
          <div
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-confirmation-title"
            data-testid="cancel-confirmation"
          >
            <h3 id="cancel-confirmation-title">Annullare la corsa?</h3>

            <p>Sei sicuro di voler annullare questa corsa?</p>

            <div className="confirmation-actions">
              <button
                type="button"
                className="danger-button"
                data-testid="confirm-cancellation"
                onClick={() => {
                  setConfirmingCancellation(false);
                  onCancel();
                }}
              >
                Sì, annulla
              </button>

              <button
                type="button"
                className="secondary-button"
                data-testid="dismiss-cancellation"
                onClick={() => setConfirmingCancellation(false)}
              >
                No, mantieni la corsa
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Il canale è la sola sorgente degli aggiornamenti: se cade, il passeggero deve saperlo,
          o crederebbe ferma una corsa che sta avanzando. */}
      {!connected && (
        <p className="status-error" data-testid="push-disconnected">
          Canale di aggiornamento non connesso: riconnessione in corso.
        </p>
      )}

      {(finished || view.phase === 'rejected') && (
        <button type="button" data-testid="new-request" onClick={onNewRequest}>
          Richiedi un&apos;altra corsa
        </button>
      )}
    </section>
  );
}
