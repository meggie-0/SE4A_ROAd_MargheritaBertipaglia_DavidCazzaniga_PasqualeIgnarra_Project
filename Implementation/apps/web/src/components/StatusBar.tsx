import type { FleetStatusResponse } from '@road/shared';
import { useState } from 'react';
import { ORDERED_STATES, STATE_APPEARANCE } from '../robotaxi-states';

/**
 * La status bar della dashboard (DD §3.2: «status bar con riepilogo della flotta per stato»).
 *
 * I conteggi vengono dal backend e non si ricontano qui: `GET /fleet/status` li porta già calcolati
 * (`countsByState`), e ricalcolarli scorrendo l'elenco significherebbe avere due implementazioni
 * della stessa somma — quella che il `FleetMonitor` fa e quella che fa il client — che divergono al
 * primo stato aggiunto.
 *
 * **Tutti e sette gli stati sono sempre presenti, zeri compresi.** Una barra che mostrasse solo gli
 * stati occupati cambierebbe forma a ogni aggiornamento, e la colonna «in manutenzione» sparirebbe
 * proprio quando la flotta sta bene — cioè nell'istante in cui l'operatore si chiede se il pannello
 * funziona ancora.
 */

export interface StatusBarProps {
  readonly status: FleetStatusResponse | null;
  readonly stale: boolean;
  readonly selectedRobotaxiId: string | null;
  readonly onFocusRobotaxi: (robotaxiId: string) => void;
}

export function StatusBar({
  status,
  stale,
  selectedRobotaxiId,
  onFocusRobotaxi,
}: StatusBarProps): React.JSX.Element {
  const [openState, setOpenState] = useState<(typeof ORDERED_STATES)[number] | null>(null);

  return (
    <section className="status-bar" data-testid="fleet-status-bar">
      <div className="total">
        <span className="figure" data-testid="fleet-total">
          {status?.total ?? '—'}
        </span>
        <span className="caption">robotaxi</span>
      </div>

      {ORDERED_STATES.map((state, index) => {
        const vehicles = status?.robotaxis.filter((vehicle) => vehicle.state === state) ?? [];
        const isOpen = openState === state;
        const alignRight = index >= ORDERED_STATES.length - 2;

        return (
          <div
            key={state}
            className={`status-tally-wrapper ${
              alignRight ? 'status-tally-wrapper--align-right' : ''
            }`}
          >
            <button
              type="button"
              className={`tally tally-button ${isOpen ? 'tally--open' : ''}`}
              data-testid={`tally-${state}`}
              aria-expanded={isOpen}
              aria-controls={`fleet-state-menu-${state}`}
              onClick={() => setOpenState((current) => (current === state ? null : state))}
            >
              <span className="swatch" style={{ background: STATE_APPEARANCE[state].color }} />
              <span className="figure">{status?.countsByState[state] ?? '—'}</span>
              <span className="caption">{STATE_APPEARANCE[state].label}</span>
            </button>

            {isOpen && (
              <div id={`fleet-state-menu-${state}`} className="fleet-state-menu">
                <div className="fleet-state-menu-heading">
                  <strong>{STATE_APPEARANCE[state].label}</strong>
                  <span>{vehicles.length} robotaxi</span>
                </div>

                {vehicles.length === 0 ? (
                  <p className="fleet-state-empty">Nessun robotaxi in questo stato.</p>
                ) : (
                  <div className="fleet-state-list">
                    {vehicles.map((vehicle) => (
                      <button
                        key={vehicle.id}
                        type="button"
                        className={`fleet-state-vehicle ${
                          selectedRobotaxiId === vehicle.id ? 'fleet-state-vehicle--selected' : ''
                        }`}
                        onClick={() => {
                          onFocusRobotaxi(vehicle.id);
                          setOpenState(null);
                        }}
                      >
                        <strong>{vehicle.id}</strong>
                        <span>Zona {vehicle.zoneId ?? '—'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}

      {stale && (
        <span className="stale" data-testid="fleet-stale">
          dati non aggiornati
        </span>
      )}
    </section>
  );
}
