import type { ControlMode, StrategyName, TrafficLevel } from '@road/shared';

/**
 * La porta del `ModeController` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Le quattro operazioni sono quelle del DD §2.2.1 — `onTrafficLevel`, `setManual`, `enableAuto`,
 * `getMode` — e nient'altro. In particolare **non c'è `setActiveStrategy`**: la strategia attiva ha
 * un solo scrittore, `AllocationPort.setActiveStrategy(name, source)`, e questo componente lo
 * chiama. Due scrittori per la stessa colonna avrebbero reso la scrittura atomica di NFR10 una
 * proprietà da mantenere a mano in due posti.
 *
 * **Che cosa possiede davvero questo componente.** Non la strategia: la *decisione* su quando
 * cambiarla. È la distinzione che tiene separate le due responsabilità del DD §2.4, Figura 2.6 —
 * `AllocationManager` sa *come* si scrive una strategia, `ModeController` sa *se* si può. Il
 * secondo è l'unico scrittore del modo di controllo nella direzione `MANUAL → AUTO`; nell'altra
 * direzione scrive `AllocationManager`, perché R13 lega il passaggio a Manual alla scelta di una
 * politica e le due cose devono finire nella stessa transazione.
 *
 * `mode` non è raggiunto da `allocation`, ed è voluto: l'arco della Figura 2.1 va da qui a lì. Se
 * `AllocationManager` chiedesse a `ModeController` il permesso prima di scrivere, i due moduli si
 * importerebbero a vicenda e nessuno dei due sarebbe più riscrivibile da solo.
 */

/**
 * La strategia che compete a ciascun livello di traffico in modo Auto (DD §2.4, «The hysteresis
 * rule, stated completely»; RASD R12).
 *
 * `MEDIUM` è assente, e **l'assenza è la regola**: è la banda morta fra le due soglie: si avvisa
 * l'operatore e non si commuta, in nessuna delle due direzioni. Scriverlo come una tabella parziale
 * invece che come tre rami di `if` rende l'isteresi leggibile in tre righe e impossibile da
 * dimenticare per metà — la simmetria che NFR9 vieta sarebbe visibile qui a occhio nudo.
 */
export const STRATEGY_BY_TRAFFIC: Readonly<Partial<Record<TrafficLevel, StrategyName>>> = {
  LOW: 'NEAREST_AVAILABLE',
  HIGH: 'MINIMUM_ETA',
};

/**
 * La strategia che R12 **suggerisce** all'operatore sulla soglia intermedia, senza applicarla.
 *
 * È la stessa di `HIGH`, e non è un caso: l'alert su `MEDIUM` esiste per dire «il traffico sta
 * salendo, valuta di allocare a tempo di arrivo». Sta qui come costante e non come letterale
 * dentro il controller perché è il contenuto di un requisito — «suggesting a switch to the Minimum
 * ETA strategy» — e i contenuti dei requisiti si nominano.
 */
export const SUGGESTED_ON_MEDIUM: StrategyName = 'MINIMUM_ETA';

export abstract class ModePort {
  /**
   * Registra il livello di traffico osservato e applica la regola di isteresi (R12, NFR9).
   *
   * Tre effetti possibili, secondo la tabella del DD §2.4:
   *
   * - in modo Auto su `LOW` o `HIGH`, se la strategia che compete a quel livello non è già attiva,
   *   la commuta e lo notifica all'operatore;
   * - in modo Auto su `MEDIUM`, **avvisa e non commuta** — in nessuna delle due direzioni;
   * - in modo Manual non commuta mai, qualunque sia il livello (R13, NFR10).
   *
   * In tutti e tre i casi il livello viene **persistito** come ultimo noto (decisione D20), modo
   * Manual compreso: `enableAuto()` deve poterlo rivalutare subito (decisione D11), e una replica
   * del tier applicativo che non ha gestito questa chiamata non lo saprebbe se restasse in memoria
   * (NFR3).
   */
  abstract onTrafficLevel(level: TrafficLevel): Promise<void>;

  /**
   * La scelta manuale dell'operatore: rende attiva la strategia indicata e porta il sistema in modo
   * Manual, **nella stessa transazione** (R13, NFR10).
   *
   * L'atomicità non è ottenuta qui ma delegata: `AllocationPort.setActiveStrategy(name, 'manual')`
   * scrive strategia e modo con una sola `UPDATE`. È la ragione per cui la firma di quel metodo
   * porta l'origine del cambiamento invece di lasciarla dedurre — senza, questo componente
   * dovrebbe fare due scritture, e un'interruzione fra le due lascerebbe la strategia manuale
   * attiva con il sistema ancora in Auto, che è esattamente la condizione con cui il DD §4.3
   * falsifica NFR10.
   *
   * Solleva `UnknownStrategyError` se il nome non corrisponde a una strategia registrata.
   */
  abstract setManual(name: StrategyName): Promise<void>;

  /**
   * Riporta il sistema in modo Auto e **rivaluta subito** l'ultimo livello di traffico noto
   * (R13, decisione D11).
   *
   * La rivalutazione non è un extra: senza, il sistema resterebbe sulla scelta manuale dichiarandosi
   * automatico, e R12 — «in Auto Mode the system dynamically manages the active strategy» —
   * sarebbe violato per un tempo che nessuno può limitare, cioè fino alla prossima lettura del
   * traffico. Su `MEDIUM` la rivalutazione **tiene** la strategia attiva in quell'istante, perché
   * la banda morta non commuta in nessuna delle due direzioni.
   *
   * Se nessun livello è ancora stato osservato non c'è niente da rivalutare e la strategia resta
   * quella che è: il sistema è in Auto e commuterà alla prima lettura.
   *
   * Idempotente: chiamarla in modo Auto rivaluta e basta.
   */
  abstract enableAuto(): Promise<void>;

  /**
   * Il modo di controllo corrente, letto dalla sua unica sede autorevole — il record `system_mode` —
   * attraverso `PersistencePort` (DD §2.2.1).
   *
   * Esiste perché NFR10 chiede che il modo sia sempre visibile sulla dashboard (DD §3.2), e un
   * valore sempre visibile ha bisogno di una via di lettura. Come per la strategia attiva, non c'è
   * una copia in memoria: due repliche che tenessero il modo ciascuna per sé mostrerebbero
   * all'operatore un Auto/Manual diverso a seconda di quale ha risposto (NFR3).
   */
  abstract getMode(): Promise<ControlMode>;
}
