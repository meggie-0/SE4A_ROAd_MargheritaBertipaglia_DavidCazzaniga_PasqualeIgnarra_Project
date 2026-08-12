import type { NotificationDelivery } from './notification.port';

/**
 * Il **secondo livello dell'Observer** (DD §2.3.3, Figura 2.4; decisione D7).
 *
 * `notifications` espone due porte, come `fleet` e come `platform` (HARNESS.md §3), e la divisione
 * segue quella del DD:
 *
 * - `notification.port.ts` è il lato **soggetti**: `fleet` e `rides` notificano di lì;
 * - questo file è il lato **connessioni**: il `gateway` registra una sessione quando un client apre
 *   la sua WebSocket e la toglie quando la chiude.
 *
 * Sono due insiemi di chiamanti disgiunti con vite diverse, e tenerli in una porta sola avrebbe
 * dato a `fleet` la possibilità di registrare sessioni e al `gateway` quella di inventare eventi di
 * dominio. Nessuno dei due deve poterlo fare.
 *
 * **Perché le sessioni stanno qui e non nel `gateway`.** Chi riceve che cosa è una regola di
 * dominio — un passeggero vede la propria corsa e nessun'altra — e il `gateway` per CLAUDE.md non
 * contiene logica di dominio: importa porte e pubblica trasporto. Quello che il `gateway` fornisce
 * è la sola cosa che sa davvero, cioè come si spedisce un messaggio su quella connessione: la passa
 * al costruttore come `NotificationTransport`. Così il filtro è testabile senza aprire una socket,
 * e sostituire Socket.IO con altro non tocca una riga di questo modulo.
 */

/**
 * Come si spedisce un messaggio su una connessione aperta.
 *
 * Sincrona e senza valore di ritorno: dal punto di vista del dominio la consegna è «messa in
 * partenza», non «arrivata». Attendere l'ack di un client renderebbe la durata di una transizione
 * di stato dipendente dalla rete del passeggero.
 */
export type NotificationTransport = (delivery: NotificationDelivery) => void;

/**
 * Una sessione client registrata sul `NotificationManager`.
 *
 * Classe astratta e non interfaccia: le due sottoclassi sono le due classi che il DD §2.3.3 pretende
 * esistano *con quel nome* nel codice, e la superclasse comune è ciò che permette al manager di
 * tenerne un registro solo. Il metodo di consegna però **non** è dichiarato qui — `PassengerAppSession`
 * espone `pushToPassenger()` e `OperatorDashboardSession` espone `pushToOperator()`, come nella
 * Figura 2.4 — perché il manager le tratta in modo diverso e deve accorgersene il compilatore, non
 * un `instanceof` scritto a mano.
 */
export abstract class NotificationSession {
  protected constructor(protected readonly transport: NotificationTransport) {}
}

/**
 * La sessione dell'app passeggero: riceve **solo** gli eventi delle corse del proprio passeggero.
 *
 * Il filtro è il requisito, non un'ottimizzazione: un passeggero che ricevesse gli eventi delle
 * corse altrui saprebbe dove si trovano gli altri utenti del sistema. È il criterio che il cancello
 * di M5 verifica in negativo — «e **nessun** evento relativo a corse altrui».
 */
export class PassengerAppSession extends NotificationSession {
  constructor(
    readonly passengerId: string,
    transport: NotificationTransport,
  ) {
    super(transport);
  }

  pushToPassenger(delivery: NotificationDelivery): void {
    this.transport(delivery);
  }
}

/**
 * La sessione della dashboard operatore: riceve gli eventi di **flotta**, per tutti i veicoli.
 *
 * Non porta un identificatore, e la differenza rispetto alla sessione passeggero è il punto: un
 * operatore sorveglia l'intera flotta (R7, G8), quindi non c'è niente su cui filtrare. Le due
 * classi esistono separate proprio perché rispondono in modo diverso alla domanda «questo evento è
 * per te?».
 */
export class OperatorDashboardSession extends NotificationSession {
  constructor(transport: NotificationTransport) {
    super(transport);
  }

  pushToOperator(delivery: NotificationDelivery): void {
    this.transport(delivery);
  }
}

/**
 * La porta con cui il `gateway` apre e chiude le sottoscrizioni.
 *
 * Simmetrica per costruzione: ogni `registerSession` ha il suo `removeSession`, e il cancello di M5
 * verifica che dopo la disconnessione **non resti alcun riferimento**. È il difetto tipico di questo
 * pattern: un observer che nessuno deregistra tiene in vita la connessione morta, e il manager
 * continua a spedire su una socket chiusa finché il processo non finisce la memoria.
 */
export abstract class NotificationSessionPort {
  /** Registra la sessione di un client appena connesso. */
  abstract registerSession(session: NotificationSession): void;

  /**
   * Toglie la sessione dal registro. Idempotente: una disconnessione può arrivare due volte, e la
   * seconda non deve essere un errore.
   */
  abstract removeSession(session: NotificationSession): void;

  /**
   * Le sessioni registrate in questo momento.
   *
   * Esiste perché il criterio di completamento di M5 lo richiede: «alla disconnessione il subscriber
   * viene rimosso e non restano riferimenti» è un'affermazione sul registro, e senza un modo di
   * leggerlo sarebbe invérificabile. Restituisce una copia in sola lettura, così un chiamante non
   * può modificare il registro passando dalla porta sbagliata.
   */
  abstract registeredSessions(): readonly NotificationSession[];
}
