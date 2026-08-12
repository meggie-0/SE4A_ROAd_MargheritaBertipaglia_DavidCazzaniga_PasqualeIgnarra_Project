import { Logger } from '@nestjs/common';
import {
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from '@nestjs/websockets';
import {
  NOTIFICATION_AUTH_FIELD,
  NOTIFICATION_EVENT,
  NOTIFICATIONS_NAMESPACE,
  type NotificationPush,
  type UserRole,
} from '@road/shared';
import type { Socket } from 'socket.io';

import { TokenVerifierPort } from '../auth/access-control.port';
import type { NotificationDelivery } from '../notifications/notification.port';
import {
  NotificationSessionPort,
  OperatorDashboardSession,
  PassengerAppSession,
  type NotificationSession,
  type NotificationTransport,
} from '../notifications/session.port';

/**
 * Il canale push dell'API Gateway (DD §2.2, §2.6.2; R6, G7, NFR2).
 *
 * Fa **tre cose e nessuna di dominio**, che è ciò che il gateway deve fare secondo la Regola 1:
 *
 * 1. autentica l'handshake, chiedendo a `TokenVerifierPort` — la verifica del token resta di `auth`;
 * 2. costruisce la sessione giusta per il ruolo e la registra sul `NotificationManager` attraverso
 *    `NotificationSessionPort`, deregistrandola alla disconnessione (DD §2.3.3);
 * 3. serializza ciò che la sessione consegna e lo mette sulla socket.
 *
 * Chi riceve che cosa **non si decide qui**: lo decide il `NotificationManager` interrogando le
 * sessioni, ed è giusto così — «un passeggero vede solo le proprie corse» è una regola di dominio,
 * e scritta nel trasporto sarebbe verificabile solo alzando una socket vera.
 *
 * **Le room.** Ogni client entra in una room — `passenger:<id>` oppure `operators` (MILESTONES.md
 * §M5) — ma la consegna di un singolo evento passa dalla sessione e non dalla room, e non è una
 * ridondanza casuale: sono due meccanismi con due scopi. La room è l'**indirizzo** — dice al
 * trasporto come si raggiunge un passeggero o l'insieme degli operatori, ed è ciò che serve a chi
 * un giorno volesse diffondere un messaggio senza passare dagli eventi di dominio — mentre la
 * sessione è l'**autorità** su chi ha diritto a vedere cosa. Consegnare due volte, una per via,
 * duplicherebbe ogni notifica: qui la via è una sola, e la room resta l'indirizzo che la milestone
 * chiede esista.
 */
@WebSocketGateway({
  namespace: NOTIFICATIONS_NAMESPACE,
  /**
   * L'origine non è ristretta come lo è per l'HTTP, e vale la pena dire perché.
   *
   * `main.ts` legge `CORS_ORIGINS` dal `ConfigService`, che è disponibile solo dopo che `.env` è
   * stato caricato; le opzioni di questo decoratore invece si valutano quando il file viene
   * importato, cioè prima. Leggerle da `process.env` qui darebbe una restrizione che in sviluppo
   * funziona e in produzione si spegne in silenzio — la peggiore delle due.
   *
   * Non è la restrizione d'origine a proteggere questo canale: è l'handshake. Senza un token valido
   * la socket si chiude prima di ricevere qualunque cosa, e ogni sessione riceve solo ciò che le
   * compete. Il controllo d'origine è una difesa del *browser* contro pagine di terzi, e un client
   * non-browser lo ignora comunque.
   */
  cors: { origin: true },
})
export class NotificationsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(NotificationsGateway.name);

  /**
   * La sessione di ogni socket connessa.
   *
   * Serve alla disconnessione: Socket.IO consegna la socket, non la sessione, e senza questa mappa
   * non ci sarebbe modo di sapere **quale** oggetto togliere dal registro del manager. È il difetto
   * classico dell'Observer — deregistrare l'oggetto sbagliato, o non deregistrare affatto — e il
   * cancello di M5 lo verifica contando i riferimenti rimasti.
   */
  private readonly sessions = new Map<string, NotificationSession>();

  constructor(
    private readonly registry: NotificationSessionPort,
    private readonly tokens: TokenVerifierPort,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    const token: unknown = client.handshake.auth[NOTIFICATION_AUTH_FIELD];
    const user = typeof token === 'string' ? await this.tokens.verify(token) : null;

    if (user === null) {
      // Nessun token valido, nessuna sessione: la socket si chiude subito. Non c'è un canale
      // anonimo, perché ogni evento che ci viaggia sopra riguarda qualcuno.
      client.disconnect(true);
      return;
    }

    const transport = (delivery: NotificationDelivery): void => {
      client.emit(NOTIFICATION_EVENT, serialise(delivery));
    };

    /**
     * La sessione si sceglie con uno `switch` esaustivo sul ruolo, non con un ternario.
     *
     * Con due soli ruoli le due forme sono equivalenti *oggi*. La differenza si vede il giorno in
     * cui `USER_ROLES` ne prende un terzo: il ternario lo tratterebbe come un passeggero, in
     * silenzio, dandogli una sessione con il filtro sbagliato; lo `switch` con ritorno tipizzato
     * non compila finché quel caso non viene deciso.
     */
    const session: NotificationSession = sessionFor(user.role, user.id, transport);
    await client.join(user.role === 'OPERATOR' ? OPERATORS_ROOM : passengerRoom(user.id));

    this.sessions.set(client.id, session);
    this.registry.registerSession(session);

    /**
     * Il client può essere caduto **durante** l'handshake.
     *
     * Fra l'inizio di questo metodo e questa riga ci sono due attese — la verifica del token e
     * `join()` — e Socket.IO non aspetta che `handleConnection` finisca prima di poter invocare
     * `handleDisconnect`. Se la socket muore in quella finestra, la disconnessione trova la mappa
     * ancora vuota e non toglie nulla; un istante dopo la registrazione qui sopra iscrive la
     * sessione di una connessione già morta, e nessuno la toglierà più. È esattamente la perdita
     * che il registro deve evitare, e si chiude rileggendo lo stato della socket dopo aver
     * registrato: `handleDisconnect` è idempotente, quindi chiamarlo qui è sicuro anche nel caso
     * in cui sia già passato.
     */
    if (!client.connected) this.handleDisconnect(client);
  }

  handleDisconnect(client: Socket): void {
    const session = this.sessions.get(client.id);
    if (session === undefined) return;

    // Prima dalla mappa, poi dal registro: se la seconda sollevasse, un secondo `disconnect` non
    // ritenterebbe una rimozione già fatta.
    this.sessions.delete(client.id);
    this.registry.removeSession(session);
    this.logger.debug(`Sessione chiusa per la socket ${client.id}.`);
  }
}

/** La sessione che compete a un ruolo. Esaustiva su `UserRole`: un ruolo nuovo non compila. */
function sessionFor(
  role: UserRole,
  userId: string,
  transport: NotificationTransport,
): NotificationSession {
  switch (role) {
    case 'OPERATOR':
      return new OperatorDashboardSession(transport);
    case 'PASSENGER':
      return new PassengerAppSession(userId, transport);
  }
}

/** La room di un passeggero e quella degli operatori (MILESTONES.md §M5). */
export const OPERATORS_ROOM = 'operators';
export const passengerRoom = (passengerId: string): string => `passenger:${passengerId}`;

/**
 * Dalla consegna del dominio al messaggio sul filo.
 *
 * L'unica trasformazione è la data, che diventa una stringa ISO 8601: il dominio lavora con `Date`,
 * JSON no. Che sia il gateway a farla è la stessa divisione di responsabilità dei DTO HTTP — il
 * dominio non sa che il trasporto è JSON, e il giorno in cui non lo fosse più cambierebbe solo
 * questa funzione.
 */
function serialise(delivery: NotificationDelivery): NotificationPush {
  return {
    type: delivery.type,
    message: delivery.message,
    occurredAt: delivery.occurredAt.toISOString(),
    rideRequestId: delivery.rideRequestId,
    robotaxiId: delivery.robotaxiId,
    robotaxiState: delivery.robotaxiState,
    rideStatus: delivery.rideStatus,
  };
}
