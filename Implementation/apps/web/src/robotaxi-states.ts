import { ROBOTAXI_STATES, type RobotaxiState } from '@road/shared';

/**
 * Il vocabolario visivo degli stati del veicolo (DD §3.2: «marker colorati per stato»).
 *
 * Un posto solo per colore ed etichetta: mappa, legenda e status bar leggono da qui, e senza questo
 * file la mappa direbbe «verde = disponibile» mentre la barra colorerebbe la stessa colonna in un
 * altro modo — un errore che nessun test coglie e che l'operatore paga.
 *
 * L'ordine è quello di `ROBOTAXI_STATES` in `@road/shared`, cioè quello della macchina a stati del
 * DD §2.6.3, Figura 2.10: la status bar li mostra nell'ordine in cui un veicolo li attraversa, non
 * in ordine alfabetico.
 */

export interface StateAppearance {
  readonly label: string;
  readonly color: string;
}

export const STATE_APPEARANCE: Record<RobotaxiState, StateAppearance> = {
  AVAILABLE: { label: 'Disponibili', color: '#4ade80' },
  ASSIGNED: { label: 'Assegnati', color: '#facc15' },
  ARRIVING: { label: 'In avvicinamento', color: '#fb923c' },
  ARRIVED: { label: 'Al ritiro', color: '#f472b6' },
  IN_RIDE: { label: 'In corsa', color: '#38bdf8' },
  REBALANCING: { label: 'In riposizionamento', color: '#a78bfa' },
  MAINTENANCE: { label: 'In manutenzione', color: '#94a3b8' },
};

/** I sette stati nell'ordine della Figura 2.10. */
export const ORDERED_STATES: readonly RobotaxiState[] = ROBOTAXI_STATES;
