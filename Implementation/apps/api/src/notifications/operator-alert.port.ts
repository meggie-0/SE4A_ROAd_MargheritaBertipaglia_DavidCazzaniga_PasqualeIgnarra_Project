import type { OperatorAlertRecord } from '../persistence/persistence.port';

/**
 * La lettura dello **storico degli alert dell'operatore** (decisione D77).
 *
 * È la terza porta di `notifications`, e le tre corrispondono a tre chiamanti disgiunti:
 * `NotificationPort` guarda verso i soggetti che emettono eventi, `NotificationSessionPort` verso
 * il gateway che apre e chiude le connessioni, e questa verso il gateway che *legge*. La divisione è
 * la stessa che la decisione D40 argomenta per le prime due — tenerle in una porta sola darebbe a
 * `fleet` la possibilità di registrare sessioni e al gateway quella di inventare eventi.
 *
 * **Perché non basta `PersistencePort`.** Il `gateway` non la inietta mai, in nessun controller: le
 * letture passano sempre dal modulo che possiede il concetto, o il confine fra moduli sarebbe una
 * convenzione invece di un vincolo. Qui il concetto è degli alert, e degli alert risponde
 * `notifications`.
 *
 * Una sola operazione, e senza paginazione: l'unico consumatore è un pannello che mostra gli ultimi
 * eventi. Una pagina che nessuno chiede è una rotta che nessuno prova.
 */
export abstract class OperatorAlertPort {
  /**
   * Gli ultimi alert, **dal più recente**.
   *
   * L'ordine è quello in cui il pannello li mostra, e non è una comodità del chiamante: il limite ha
   * senso solo insieme all'ordinamento — «gli ultimi N» presi in ordine crescente sarebbero i primi
   * N, cioè esattamente quelli che non interessano a nessuno.
   */
  abstract recentAlerts(limit: number): Promise<readonly OperatorAlertRecord[]>;
}
