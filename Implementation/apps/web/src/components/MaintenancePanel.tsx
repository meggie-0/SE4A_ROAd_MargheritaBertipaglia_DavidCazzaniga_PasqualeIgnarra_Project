import type { FleetVehicle } from '@road/shared';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { STATE_APPEARANCE } from '../robotaxi-states';

export interface MaintenancePanelProps {
  readonly vehicle: FleetVehicle | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onStartMaintenance: (reason: string) => void;
  readonly onCompleteMaintenance: () => void;
}

/**
 * Comandi di manutenzione per il robotaxi selezionato sulla mappa.
 *
 * Il pannello non modifica direttamente lo stato della flotta: invia
 * il comando ad App, che chiamerà l'API. La validità definitiva della
 * transizione resta responsabilità della macchina a stati nel backend.
 */
export function MaintenancePanel(props: MaintenancePanelProps): React.JSX.Element {
  const { vehicle, busy, error, onStartMaintenance, onCompleteMaintenance } = props;

  const [reason, setReason] = useState('');

  /**
   * Cambiando robotaxi non deve rimanere il motivo scritto
   * per quello selezionato precedentemente.
   */
  useEffect(() => {
    setReason('');
  }, [vehicle?.id]);

  function submitMaintenance(event: SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();

    const normalizedReason = reason.trim();
    if (normalizedReason.length === 0) return;

    onStartMaintenance(normalizedReason);
  }

  if (vehicle === null) {
    return (
      <section className="panel maintenance-panel" data-testid="maintenance-panel">
        <h2>Manutenzione</h2>

        <p className="muted">Seleziona un robotaxi sulla mappa per visualizzarne i comandi.</p>
      </section>
    );
  }

  const appearance = STATE_APPEARANCE[vehicle.state];

  return (
    <section
      className="panel maintenance-panel"
      data-testid="maintenance-panel"
      data-robotaxi-id={vehicle.id}
      data-robotaxi-state={vehicle.state}
    >
      <h2>Manutenzione</h2>

      <dl className="readout">
        <dt>Robotaxi</dt>
        <dd data-testid="selected-robotaxi-id">{vehicle.id}</dd>

        <dt>Stato</dt>
        <dd>{appearance.label}</dd>

        <dt>Zona</dt>
        <dd>{vehicle.zoneId ?? '—'}</dd>
      </dl>

      {vehicle.state === 'AVAILABLE' && (
        <form className="maintenance-form" onSubmit={submitMaintenance}>
          <label>
            Motivo dell’intervento
            <input
              type="text"
              value={reason}
              minLength={1}
              maxLength={255}
              required
              disabled={busy}
              data-testid="maintenance-reason"
              placeholder="Es. controllo periodico dei sensori"
              onChange={(event) => setReason(event.target.value)}
            />
          </label>

          <button
            type="submit"
            disabled={busy || reason.trim().length === 0}
            data-testid="start-maintenance"
          >
            {busy ? 'Operazione in corso…' : 'Metti in manutenzione'}
          </button>
        </form>
      )}

      {vehicle.state === 'MAINTENANCE' && (
        <>
          <p className="mode-explanation">
            Il robotaxi è fuori servizio e non può essere assegnato a nuove corse.
          </p>

          <button
            type="button"
            disabled={busy}
            data-testid="complete-maintenance"
            onClick={onCompleteMaintenance}
          >
            {busy ? 'Operazione in corso…' : 'Completa manutenzione'}
          </button>
        </>
      )}

      {vehicle.state !== 'AVAILABLE' && vehicle.state !== 'MAINTENANCE' && (
        <p className="mode-explanation">
          Il robotaxi non può entrare in manutenzione mentre si trova nello stato{' '}
          {appearance.label.toLowerCase()}.
        </p>
      )}

      {error !== null && (
        <p className="status-error" data-testid="maintenance-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
