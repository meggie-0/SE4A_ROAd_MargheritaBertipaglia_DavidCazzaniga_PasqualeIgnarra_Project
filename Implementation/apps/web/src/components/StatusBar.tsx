import type { FleetStatusResponse } from '@road/shared';

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
}

export function StatusBar({ status, stale }: StatusBarProps): React.JSX.Element {
  return (
    <section className="status-bar" data-testid="fleet-status-bar">
      <div className="total">
        <span className="figure" data-testid="fleet-total">
          {status?.total ?? '—'}
        </span>
        <span className="caption">robotaxi</span>
      </div>

      {ORDERED_STATES.map((state) => (
        <div key={state} className="tally" data-testid={`tally-${state}`}>
          <span className="swatch" style={{ background: STATE_APPEARANCE[state].color }} />
          <span className="figure">{status?.countsByState[state] ?? '—'}</span>
          <span className="caption">{STATE_APPEARANCE[state].label}</span>
        </div>
      ))}

      {stale && (
        <span className="stale" data-testid="fleet-stale">
          dati non aggiornati
        </span>
      )}
    </section>
  );
}
