import type { RideRequestResponse } from '@road/shared';
import { useRef, useState } from 'react';
import { PHASE_LABELS, type RidePhase, type RideView } from '../ride-phase';
import { ConfirmationDialog } from './ConfirmationDialog';
import {
  statusBottomSheetPositionAfterDrag,
  toggleStatusBottomSheet,
  type StatusBottomSheetPosition,
} from '../status-bottom-sheet';
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
  readonly nowMs: number;
}

/** Le cinque fasi che il DD §3.1 elenca, in ordine: è la barra di avanzamento della corsa. */
const PROGRESSION: readonly RidePhase[] = [
  'searching',
  'assigned',
  'arriving',
  'arrived',
  'in_ride',
];

function remainingEtaMinutes(
  etaMinutes: number,
  etaUpdatedAt: string | null,
  nowMs: number,
): number {
  const initialMinutes = Math.max(1, Math.ceil(etaMinutes));

  if (etaUpdatedAt === null || nowMs <= 0) {
    return initialMinutes;
  }

  const updatedAtMs = Date.parse(etaUpdatedAt);

  if (!Number.isFinite(updatedAtMs)) {
    return initialMinutes;
  }

  const elapsedMinutes = Math.max(0, Math.floor((nowMs - updatedAtMs) / 60_000));

  return Math.max(1, initialMinutes - elapsedMinutes);
}

function formatEta(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) {
    return `${String(minutes).padStart(2, '0')} min`;
  }

  return `${String(hours).padStart(2, '0')}:${String(remainingMinutes).padStart(2, '0')}`;
}

function formatPoint(address: string | null, point: RideRequestResponse['pickup']): string {
  return address ?? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

export function StatusPanel({
  request,
  view,
  connected,
  nowMs,
  cancelling,
  cancellationError,
  onCancel,
  onNewRequest,
}: StatusPanelProps): React.JSX.Element {
  const finished = view.phase === 'completed' || view.phase === 'cancelled';
  const [confirmingCancellation, setConfirmingCancellation] = useState(false);
  const [sheetPosition, setSheetPosition] = useState<StatusBottomSheetPosition>('collapsed');

  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartY = useRef<number | null>(null);
  const dragged = useRef(false);
  const cancellable = ['searching', 'assigned', 'arriving', 'arrived'].includes(view.phase);
  const reached = PROGRESSION.indexOf(view.phase);
  const displayedEta =
    view.etaMinutes === null
      ? null
      : remainingEtaMinutes(view.etaMinutes, view.etaUpdatedAt, nowMs);

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    dragStartY.current = event.clientY;
    dragged.current = false;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>): void {
    if (dragStartY.current === null) {
      return;
    }

    const movement = event.clientY - dragStartY.current;

    if (Math.abs(movement) > 5) {
      dragged.current = true;
    }

    const allowedMovement =
      sheetPosition === 'collapsed' ? Math.min(0, movement) : Math.max(0, movement);

    setDragOffset(allowedMovement);
  }

  function handlePointerUp(event: React.PointerEvent<HTMLButtonElement>): void {
    if (dragStartY.current === null) {
      return;
    }

    const movement = event.clientY - dragStartY.current;

    if (Math.abs(movement) > 5) {
      dragged.current = true;
    }

    dragStartY.current = null;
    setDragging(false);
    setDragOffset(0);

    setSheetPosition((current) => statusBottomSheetPositionAfterDrag(current, movement));
  }

  function handlePointerCancel(): void {
    dragStartY.current = null;
    dragged.current = false;
    setDragOffset(0);
    setDragging(false);
  }

  function handleHandleClick(): void {
    if (dragged.current) {
      dragged.current = false;
      return;
    }

    setSheetPosition((current) => toggleStatusBottomSheet(current));
  }
  return (
    <>
      <section
        className={`panel status-panel status-panel--${sheetPosition} ${
          dragging ? 'status-panel--dragging' : ''
        }`}
        data-testid="ride-status-sheet"
        data-position={sheetPosition}
        style={{
          transform: dragOffset === 0 ? undefined : `translateY(${dragOffset}px)`,
        }}
      >
        <button
          type="button"
          className="status-bottom-sheet-handle"
          aria-label={
            sheetPosition === 'collapsed'
              ? 'Espandi i dettagli della corsa'
              : 'Riduci i dettagli della corsa'
          }
          data-testid="ride-status-sheet-handle"
          aria-expanded={sheetPosition === 'expanded'}
          aria-controls="status-panel-details"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onClick={handleHandleClick}
        >
          <span aria-hidden="true" />
        </button>

        <h2>La tua corsa</h2>

        <p className="phase" data-testid="ride-phase" data-phase={view.phase} role="status">
          {PHASE_LABELS[view.phase]}
        </p>

        {displayedEta !== null && (
          <p className="eta" data-testid="ride-eta">
            Arrivo stimato fra {formatEta(displayedEta)}
          </p>
        )}
        <div
          id="status-panel-details"
          className="status-panel-details"
          aria-hidden={sheetPosition === 'collapsed'}
        >
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

          <div className="status-route-reference">
            <div>
              <span>Partenza</span>
              <strong>{formatPoint(request.pickupAddress, request.pickup)}</strong>
            </div>

            <div>
              <span>Destinazione</span>
              <strong>{formatPoint(request.destinationAddress, request.destination)}</strong>
            </div>
          </div>

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
        </div>
      </section>

      {confirmingCancellation && (
        <ConfirmationDialog
          titleId="cancel-confirmation-title"
          title="Annullare la corsa?"
          message="Sei sicuro di voler annullare questa corsa?"
          confirmLabel="Sì, annulla"
          dismissLabel="No, mantieni la corsa"
          dialogTestId="cancel-confirmation"
          confirmTestId="confirm-cancellation"
          dismissTestId="dismiss-cancellation"
          onConfirm={() => {
            setConfirmingCancellation(false);
            onCancel();
          }}
          onDismiss={() => setConfirmingCancellation(false)}
        />
      )}
    </>
  );
}
