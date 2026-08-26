import { TRAFFIC_LEVELS, type ControlMode, type TrafficLevel } from '@road/shared';

/**
 * Il vocabolario visivo del livello di traffico (RASD §2.3: «a clear overview of traffic levels»).
 *
 * Sta in un file suo per la stessa ragione di `robotaxi-states.ts`: colore ed etichetta di un
 * concetto si dichiarano una volta sola, altrimenti il badge del pannello e qualunque altra vista
 * che un giorno mostri il traffico direbbero la stessa cosa in due modi.
 *
 * **Il colore non è mai l'unico veicolo dell'informazione.** Ogni livello porta la sua etichetta
 * testuale accanto alla pastiglia, perché un indicatore che distingue «basso» da «alto» solo per la
 * tinta è illeggibile a chi non distingue quelle due tinte — e questa è la dashboard su cui un
 * operatore decide se prendere il controllo della flotta.
 */

export interface TrafficAppearance {
  readonly label: string;
  readonly color: string;
}

export const TRAFFIC_APPEARANCE: Record<TrafficLevel, TrafficAppearance> = {
  LOW: { label: 'Basso', color: '#4ade80' },
  MEDIUM: { label: 'Medio', color: '#facc15' },
  HIGH: { label: 'Alto', color: '#f87171' },
};

/**
 * L'aspetto del quarto stato: **nessuna lettura ancora arrivata**.
 *
 * Non è un livello e non va confuso con `LOW`. Il sistema appena avviato non ha ancora interrogato
 * il servizio di mappe, e mostrare «basso» sarebbe un'affermazione che nessuno ha verificato: è la
 * stessa distinzione che `enableAuto()` fa quando non rivaluta niente perché il livello è nullo
 * (decisione D11). Il trattino è la convenzione che la dashboard usa già per i valori non ancora
 * noti, in `StatusBar` e nella strategia attiva di questo stesso pannello.
 */
export const TRAFFIC_UNKNOWN: TrafficAppearance = { label: 'Non rilevato', color: '#64748b' };

/** I tre livelli nell'ordine crescente di `@road/shared`, per la legenda. */
export const ORDERED_TRAFFIC_LEVELS: readonly TrafficLevel[] = TRAFFIC_LEVELS;

export function trafficAppearance(level: TrafficLevel | null): TrafficAppearance {
  return level === null ? TRAFFIC_UNKNOWN : TRAFFIC_APPEARANCE[level];
}

/**
 * Che cosa il sistema **sta facendo** con questo livello, che è l'informazione che l'operatore usa.
 *
 * Il livello da solo non dice nulla di azionabile: dice com'è il traffico, non chi sta decidendo. La
 * frase dipende quindi da entrambi i valori, e l'ordine dei casi qui sotto è l'ordine in cui i
 * requisiti si sovrappongono.
 *
 * **Il modo Manual viene prima del livello** (R13, NFR10). In Manual le osservazioni continuano a
 * registrarsi — `onTrafficLevel()` scrive sempre, decisione D20 — ma nessuna commuta niente: una
 * frase come «il sistema alloca a ETA minimo» sarebbe falsa esattamente quando l'operatore ha preso
 * il controllo, cioè nel momento in cui contare su ciò che legge gli serve di più.
 *
 * **`MEDIUM` è la banda morta, e va detto** (R12, NFR9). È il caso in cui il sistema avvisa e non
 * agisce, e senza una frase che lo dica l'operatore non ha modo di distinguere «il sistema ha
 * valutato e ha deciso di non muoversi» da «il sistema non ha ancora valutato». La strategia
 * nominata è quella che R12 prescrive di suggerire — «suggesting a switch to the Minimum ETA
 * strategy» — e resta un suggerimento: la decisione è dell'operatore.
 */
export function trafficExplanation(
  level: TrafficLevel | null,
  mode: ControlMode | null,
): string | null {
  if (level === null) {
    return 'Nessuna lettura del traffico è ancora arrivata: il sistema valuterà alla prima osservazione.';
  }

  if (mode === 'MANUAL') {
    return 'Le osservazioni continuano a essere registrate, ma finché resti in Manual nessun cambio automatico avviene.';
  }

  // Modo ancora sconosciuto: si descrive il livello senza attribuire al sistema un comportamento
  // che dipende da un valore non ancora letto.
  if (mode === null) return null;

  switch (level) {
    case 'LOW':
      return 'Traffico scorrevole: il sistema assegna il robotaxi più vicino.';
    case 'MEDIUM':
      return 'Soglia intermedia: il sistema suggerisce ETA minimo ma non commuta da solo — la scelta è tua.';
    case 'HIGH':
      return 'Traffico intenso: il sistema assegna in base al tempo di arrivo stimato.';
  }
}
