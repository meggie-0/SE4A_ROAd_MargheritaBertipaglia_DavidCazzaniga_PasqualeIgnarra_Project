import { Injectable, Logger } from '@nestjs/common';

import { PersistencePort } from '../persistence/persistence.port';

import { describeEvent } from './notification-copy';
import {
  NotificationPort,
  type DomainEvent,
  type NotificationDelivery,
  type Observer,
} from './notification.port';
import {
  NotificationSessionPort,
  OperatorDashboardSession,
  PassengerAppSession,
  type NotificationSession,
} from './session.port';

/**
 * Il `NotificationManager` (DD §2.2, §2.3.3): l'**unico observer** registrato sui soggetti, e il
 * punto in cui i due livelli dell'Observer si incontrano.
 *
 * Riceve `update(event)` da `Robotaxi` e da `Ride`, e `dispatch` lo consegna alle sessioni
 * interessate (Figura 2.4). È l'unica classe che conosce entrambi i lati, ed è per questo che
 * implementa **due porte**: `NotificationPort` verso i soggetti, `NotificationSessionPort` verso il
 * `gateway`. Nel modulo Nest la stessa istanza è registrata sotto i due token — chi inietta l'una
 * non può usare l'altra, ma il registro delle sessioni è uno solo, che è ciò che serve perché un
 * evento arrivi davvero a chi si è appena connesso.
 *
 * Il DD §2.6.4 lo chiama Singleton: qui è l'istanza unica che Nest inietta nel processo. Le sessioni
 * sono in memoria e **non** vanno condivise fra repliche del tier applicativo: una connessione
 * WebSocket vive su un processo solo, e la replica che non la ospita non ha niente da consegnarle.
 * Ciò che deve sopravvivere alla disconnessione è lo storico, e quello sta in tabella (NFR3).
 */
@Injectable()
export class NotificationManager
  extends NotificationPort
  implements Observer, NotificationSessionPort
{
  private readonly logger = new Logger(NotificationManager.name);

  /**
   * Due registri e non uno, perché la Figura 2.4 disegna due associazioni distinte e le due
   * sessioni rispondono in modo diverso a «questo evento è per te?». Con un registro solo servirebbe
   * un `instanceof` a ogni consegna, cioè il controllo di tipo scritto a mano che le classi separate
   * rendono inutile.
   *
   * Sono `Set` e non array: registrare due volte la stessa sessione — una riconnessione che il
   * client ritenta — non deve raddoppiare le consegne, e la rimozione dev'essere esatta.
   */
  private readonly passengerSessions = new Set<PassengerAppSession>();
  private readonly operatorSessions = new Set<OperatorDashboardSession>();

  constructor(private readonly persistence: PersistencePort) {
    super();
  }

  // -------------------------------------------------------------------------------------------
  // Lato soggetti: `NotificationPort`
  // -------------------------------------------------------------------------------------------

  /**
   * L'`update(event)` dell'interfaccia `Observer` (DD §2.3.3).
   *
   * Tre passi: tradurre, capire di chi è, consegnare. Lo storico si scrive **prima** della consegna
   * perché è la parte che deve sopravvivere: un client disconnesso ritrova in tabella ciò che è
   * successo mentre non c'era, mentre una push persa non lascia traccia da nessuna parte.
   *
   * **Non solleva mai.** L'evento è già accaduto — la transizione è stata scritta prima che questo
   * metodo venisse chiamato — quindi un errore qui non può disfarla: propagarlo trasformerebbe una
   * socket caduta o uno storico non scritto nel fallimento di un'operazione di dominio riuscita.
   * Viene registrato e basta, che è la sola cosa onesta da farne.
   */
  async update(event: DomainEvent): Promise<void> {
    // `describeEvent` è pura e totale: non c'è niente da proteggere qui.
    const delivery = describeEvent(event);
    const recipientId = await this.recipientOf(event);

    await this.record(delivery, recipientId);
    this.dispatch(event, delivery, recipientId);
  }

  /**
   * Il destinatario **passeggero** dell'evento, se ce n'è uno.
   *
   * Un evento di corsa lo porta già con sé; uno di veicolo porta al più la richiesta che il veicolo
   * sta servendo, e da lì si risale con una lettura. Che sia il manager a farla, e non il soggetto,
   * è voluto: `Robotaxi` non deve sapere che esiste un passeggero — nella Figura 2.10 non compare —
   * e caricarglielo addosso legherebbe la macchina a stati al modello degli utenti.
   *
   * Se la lettura fallisce si procede **senza destinatario**: la dashboard dell'operatore riceve
   * comunque il movimento del veicolo, che non dipende da chi sia il passeggero. Perdere anche
   * quello sarebbe far pagare a chi guarda la flotta un guasto che riguarda un'altra tabella.
   *
   * Va detto con precisione fin dove arriva la degradazione, perché è meno di quanto sembri: senza
   * destinatario **né** lo storico si scrive **né** il passeggero riceve, e non è un'omissione da
   * correggere — sono le due cose che di quel nome hanno bisogno. Consegnare a un passeggero
   * sconosciuto non è un'operazione che esista. Quello che resta indipendente è il resto: un guasto
   * *sullo storico* non spegne la consegna, e una socket caduta non impedisce la scrittura.
   */
  private async recipientOf(event: DomainEvent): Promise<string | null> {
    if (event.kind === 'RIDE_STATUS_CHANGED') return event.passengerId;
    if (event.rideRequestId === null) return null;

    try {
      const [request] = await this.persistence.find('ride_request', {
        where: { id: event.rideRequestId },
        limit: 1,
      });
      return request?.passengerId ?? null;
    } catch (error) {
      this.logger.error(`Destinatario non risolto per ${event.rideRequestId}: ${String(error)}`);
      return null;
    }
  }

  /**
   * Lo storico, che è la parte che deve **sopravvivere** alla disconnessione: un client che riapre
   * l'app ritrova qui ciò che è successo mentre non c'era.
   *
   * Isolato dalla consegna, e non per simmetria. Sono due guasti indipendenti — il database non
   * raggiungibile, una socket caduta — e legarli farebbe sì che un intoppo transitorio sulla
   * scrittura spenga anche lo schermo di chi in quel momento è connesso e sta guardando arrivare il
   * proprio robotaxi. La notifica in tempo reale è ciò che NFR2 promette, e non dipende dallo
   * storico.
   */
  private async record(delivery: NotificationDelivery, recipientId: string | null): Promise<void> {
    if (recipientId === null || delivery.type === null) return;

    try {
      await this.persistence.create('notification', {
        recipientId,
        rideRequestId: delivery.rideRequestId,
        type: delivery.type,
        message: delivery.message,
        createdAt: delivery.occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `Storico non scritto per ${recipientId}: ${String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  /**
   * Il `dispatch(event)` della Figura 2.4: consegna alle sessioni interessate.
   *
   * Le due regole di instradamento sono quelle del DD §2.3.3, e sono asimmetriche apposta:
   *
   * - una `PassengerAppSession` riceve **solo** gli eventi delle corse del proprio passeggero. Il
   *   confronto sull'identificatore è il requisito, non un filtro di comodo: senza, un passeggero
   *   saprebbe dove si trovano i veicoli che servono gli altri;
   * - una `OperatorDashboardSession` riceve gli eventi di **flotta**, cioè i movimenti dei veicoli,
   *   per tutti i veicoli (R7, G8). Gli eventi di corsa non le arrivano: la dashboard sorveglia la
   *   flotta, e lo stato di avanzamento del viaggio di un singolo passeggero non le serve — la
   *   stessa progressione la vede comunque, dal lato del veicolo.
   */
  private dispatch(
    event: DomainEvent,
    delivery: NotificationDelivery,
    recipientId: string | null,
  ): void {
    // Al passeggero arriva ciò che il RASD §2.2.3 chiama `Notification`, cioè ciò che ha una
    // categoria. Un evento con `type: null` è un movimento di flotta — un veicolo che torna libero,
    // uno che entra in officina — e riguarda la dashboard, non chi sta aspettando una corsa.
    if (recipientId !== null && delivery.type !== null) {
      for (const session of this.passengerSessions) {
        if (session.passengerId === recipientId) this.push(() => session.pushToPassenger(delivery));
      }
    }

    if (event.kind === 'ROBOTAXI_STATE_CHANGED') {
      for (const session of this.operatorSessions)
        this.push(() => session.pushToOperator(delivery));
    }
  }

  /**
   * Una consegna, isolata dalle altre.
   *
   * Il `try` sta **attorno alla singola sessione** e non attorno al ciclo, e la differenza è tutta
   * qui: una socket che esplode mentre le si scrive interromperebbe l'iterazione e negherebbe
   * l'evento a tutte le sessioni successive — gli operatori compresi, che vengono per ultimi. Un
   * client rotto non deve poter zittire gli altri.
   */
  private push(deliver: () => void): void {
    try {
      deliver();
    } catch (error) {
      this.logger.warn(`Consegna fallita su una sessione: ${String(error)}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Lato connessioni: `NotificationSessionPort`
  // -------------------------------------------------------------------------------------------

  registerSession(session: NotificationSession): void {
    if (session instanceof PassengerAppSession) this.passengerSessions.add(session);
    else if (session instanceof OperatorDashboardSession) this.operatorSessions.add(session);
  }

  removeSession(session: NotificationSession): void {
    if (session instanceof PassengerAppSession) this.passengerSessions.delete(session);
    else if (session instanceof OperatorDashboardSession) this.operatorSessions.delete(session);
  }

  registeredSessions(): readonly NotificationSession[] {
    return [...this.passengerSessions, ...this.operatorSessions];
  }
}
