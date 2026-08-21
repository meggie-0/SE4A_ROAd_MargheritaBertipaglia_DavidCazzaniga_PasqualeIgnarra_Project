import { STRATEGY_NAMES, type ControlMode, type StrategyName } from '@road/shared';

/**
 * Il pannello strategia (DD §3.2; RASD R8, R12, R13; NFR10).
 *
 * Tre cose, tutte visibili senza navigare (NFR6, DD §4.3): quale politica sta assegnando i veicoli,
 * in quale modo di controllo si trova il sistema, e i comandi per cambiare l'una e l'altro.
 *
 * **Il toggle Auto/Manual è sempre a schermo**, che è precisamente ciò che NFR10 chiede: «the
 * current control mode always visible». Non è un menù da aprire né una voce in una pagina di
 * impostazioni — l'operatore deve poter vedere in un colpo d'occhio se il sistema sta decidendo da
 * solo, e riprenderne il controllo senza cercare dove.
 *
 * **Non c'è un pulsante «passa a Manual».** Ci si va scegliendo una strategia, perché è ciò che R13
 * prescrive: «if the Operator manually selects a specific allocation strategy […] the system
 * immediately transitions to Manual Mode». Il contratto non offre altra via, e inventarne una qui
 * significherebbe decidere a quale politica passare al posto dell'operatore.
 */

const STRATEGY_LABELS: Record<StrategyName, string> = {
  NEAREST_AVAILABLE: 'Più vicino disponibile',
  MINIMUM_ETA: 'ETA minimo',
};

export interface StrategyPanelProps {
  readonly mode: ControlMode | null;
  readonly activeStrategy: StrategyName | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onSelectStrategy: (strategy: StrategyName) => void;
  readonly onEnableAuto: () => void;
}

export function StrategyPanel(props: StrategyPanelProps): React.JSX.Element {
  const { mode, activeStrategy, busy, error } = props;

  return (
    <section className="panel strategy-panel">
      <h2>Strategia di allocazione</h2>

      <div className="mode-toggle" data-testid="control-mode" data-mode={mode ?? 'unknown'}>
        <span className={mode === 'AUTO' ? 'mode active' : 'mode'}>Auto</span>
        <span className={mode === 'MANUAL' ? 'mode active manual' : 'mode'}>Manual</span>
      </div>

      <p className="mode-explanation">
        {mode === 'MANUAL'
          ? 'Scelta manuale attiva: nessun cambio automatico avverrà finché non riabiliti Auto.'
          : mode === 'AUTO'
            ? 'Il sistema commuta la strategia da solo al variare del traffico.'
            : 'Lettura del modo in corso…'}
      </p>

      <dl className="readout">
        <dt>Strategia attiva</dt>
        <dd data-testid="active-strategy" data-strategy={activeStrategy ?? 'unknown'}>
          {activeStrategy === null ? '—' : STRATEGY_LABELS[activeStrategy]}
        </dd>
      </dl>

      <div className="strategy-buttons">
        {STRATEGY_NAMES.map((strategy) => (
          <button
            key={strategy}
            type="button"
            data-testid={`select-strategy-${strategy}`}
            className={strategy === activeStrategy ? 'chosen' : ''}
            disabled={busy}
            onClick={() => props.onSelectStrategy(strategy)}
          >
            {STRATEGY_LABELS[strategy]}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="link-button  strategy-auto-button"
        data-testid="enable-auto"
        disabled={busy || mode === 'AUTO'}
        onClick={props.onEnableAuto}
      >
        Riabilita il modo Auto
      </button>

      {error !== null && (
        <p className="status-error" data-testid="strategy-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
