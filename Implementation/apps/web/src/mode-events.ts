import type { ModeResponse, NotificationPush } from '@road/shared';

/**
 * Come un evento del canale si riflette su ciò che il pannello strategia mostra (RASD R12, R13;
 * DD §3.2, decisione D75).
 *
 * Sta in un modulo suo per la stessa ragione di `alerts.ts`: è la parte che può **sbagliare in
 * silenzio**. Un evento scartato non produce un errore — produce un pannello che continua a mostrare
 * il valore di prima, e due parti della stessa schermata che si contraddicono. Separata dagli
 * effetti si prova con notifiche costruite a mano, senza montare React.
 *
 * **Perché una funzione sola e non una per campo.** Gli eventi che il `ModeController` emette non
 * portano tutti gli stessi campi — `MODE_CHANGED` porta modo, strategia e livello, `TRAFFIC_ALERT`
 * porta livello e strategia suggerita e **non** il modo — e la regola di fusione è la stessa per
 * tutti e tre: ciò che l'evento dice vince, ciò che tace resta com'era. Scriverla tre volte
 * significherebbe poterla far divergere in un campo solo, che è esattamente il difetto che questa
 * funzione esiste per chiudere.
 */

/**
 * La cache aggiornata, oppure `previous` immutato se l'evento non ha niente da dire.
 *
 * `appliedAt` è l'istante dell'ultimo evento già applicato, o `null` se nessuno lo è. Serve perché
 * **l'istante decide chi vince**: fra una notifica e la risposta di una `PUT` può arrivare prima
 * l'una o l'altra, e senza il confronto un evento vecchio di un secondo sovrascriverebbe il
 * risultato di un comando appena eseguito. `occurredAt` è l'istante del cambiamento, non quello
 * della consegna.
 *
 * Il chiamante riconosce «non ho applicato niente» dall'identità del risultato: se è lo stesso
 * oggetto che ha passato, non c'è nulla da scrivere in cache e nulla da ridipingere.
 */
export function applyModeEvent(
  previous: ModeResponse | undefined,
  event: NotificationPush,
  appliedAt: string | null,
): ModeResponse | undefined {
  /**
   * Cache ancora vuota: **non si inventa niente**.
   *
   * Un evento porta ciò che è cambiato, non lo stato intero: `TRAFFIC_ALERT` non dice quale
   * strategia sia attiva, e `MODE_CHANGED` non dice se una lettura del traffico sia mai arrivata.
   * Completare i buchi con dei default significherebbe mostrare come letti dei valori che nessuno
   * ha letto — la stessa distinzione per cui `trafficLevel` è annullabile invece di valere `LOW`
   * quando il sistema è appena partito. La risposta di `GET /mode` arriva comunque, ed è
   * autorevole; questa funzione aspetta.
   */
  if (previous === undefined) return undefined;

  if (appliedAt !== null && event.occurredAt <= appliedAt) return previous;

  /**
   * Ciò che l'evento tace **resta com'era**, e vale per tutti e tre i campi.
   *
   * È la metà che mancava. Il difetto che si vedeva a schermo: al passaggio `LOW → MEDIUM` il
   * pannello alert mostrava «Traffico MEDIUM: valutare il passaggio…» e il badge accanto continuava
   * a dire «Basso», perché `TRAFFIC_ALERT` nasce dalla costante `NOTHING` di
   * `notification-copy.ts` e ha quindi `mode` nullo. Un evento riconosciuto dal solo modo veniva
   * scartato per intero, livello compreso — e la banda morta di `MEDIUM`, cioè il caso in cui il
   * sistema *ha* valutato e ha deciso di non commutare, è precisamente la ragione per cui
   * l'indicatore esiste.
   *
   * Nell'altro verso vale lo stesso: una scelta manuale porta `trafficLevel` nullo finché nessuna
   * osservazione è arrivata, e senza il ripiego cancellerebbe dallo schermo un livello valido.
   */
  const mode = event.mode ?? previous.mode;
  const activeStrategy = event.strategy ?? previous.activeStrategy;
  const trafficLevel = event.trafficLevel ?? previous.trafficLevel;

  // Un evento che non sposta nessuno dei tre non merita una scrittura in cache né un ridisegno.
  if (
    mode === previous.mode &&
    activeStrategy === previous.activeStrategy &&
    trafficLevel === previous.trafficLevel
  ) {
    return previous;
  }

  return { mode, activeStrategy, trafficLevel };
}
