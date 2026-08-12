import { Logger } from '@nestjs/common';
import type { RobotaxiState } from '@road/shared';

import type { DomainEvent } from '../../../src/notifications/notification.port';
import {
  composeNotifications,
  recordOperator,
  recordPassenger,
  type NotificationsHarness,
} from '../../support/notifications';

/**
 * L'instradamento dell'Observer (DD §2.3.3, Figura 2.4; R6, G7).
 *
 * Qui l'oggetto del test è una domanda sola: **dato un evento, chi lo riceve e che cosa resta
 * scritto**. La catena che produce gli eventi — richiesta, allocazione, transizioni — è verificata
 * dai test di integrazione e dal cancello, su Postgres vero. Costruirla anche qui avrebbe reso ogni
 * caso lungo tre volte senza aggiungere una sola asserzione sull'instradamento, che è la parte che
 * si può sbagliare in silenzio.
 *
 * Le sessioni sono quelle vere: `PassengerAppSession` e `OperatorDashboardSession` con il loro
 * filtro. A essere sostituito è solo il trasporto, che accumula in un array invece di scrivere su
 * una socket — vedi `support/notifications.ts`.
 */

const AT = new Date('2026-05-04T09:15:00.000Z');
const GIULIA = 'passeggero-giulia';
const MARCO = 'passeggero-marco';

let harness: NotificationsHarness;

/** Un evento di veicolo che riguarda la corsa indicata. */
const robotaxiEvent = (
  from: RobotaxiState,
  to: RobotaxiState,
  rideRequestId: string | null,
): DomainEvent => ({
  kind: 'ROBOTAXI_STATE_CHANGED',
  occurredAt: AT,
  robotaxiId: 'RT-01',
  from,
  to,
  rideRequestId,
});

/** Una richiesta di corsa già scritta, così che il manager possa risalire al passeggero. */
async function givenRideRequest(id: string, passengerId: string): Promise<void> {
  await harness.persistence.create('ride_request', {
    id,
    passengerId,
    kind: 'IMMEDIATE',
    status: 'ACCEPTED',
    pickupLat: 45.4642,
    pickupLon: 9.19,
    pickupAddress: null,
    destinationLat: 45.4863,
    destinationLon: 9.205,
    destinationAddress: null,
    assignedRobotaxiId: 'RT-01',
  });
}

beforeEach(async () => {
  harness = await composeNotifications();
});

afterEach(async () => {
  await harness?.close();
});

describe('[R6][G7] Ride status notifications — instradamento dell Observer', () => {
  it('il passeggero riceve la progressione della propria corsa', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));
    await harness.notifications.update(robotaxiEvent('ASSIGNED', 'ARRIVING', 'corsa-di-giulia'));
    await harness.notifications.update(robotaxiEvent('ARRIVING', 'ARRIVED', 'corsa-di-giulia'));
    await harness.notifications.update(robotaxiEvent('ARRIVED', 'IN_RIDE', 'corsa-di-giulia'));

    // È la sequenza che MILESTONES.md §M5 chiede, nell'ordine in cui è accaduta.
    expect(giulia.robotaxiStates()).toEqual(['ASSIGNED', 'ARRIVING', 'ARRIVED', 'IN_RIDE']);
    expect(giulia.received.map((one) => one.type)).toEqual([
      'VEHICLE_ASSIGNED',
      'VEHICLE_ARRIVING',
      'VEHICLE_ARRIVED',
      'RIDE_STATUS_CHANGED',
    ]);
  });

  it('e **nessun** evento delle corse altrui', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    await givenRideRequest('corsa-di-marco', MARCO);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    const marco = recordPassenger(harness.sessions, MARCO);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-marco'));

    // Il filtro non è un'ottimizzazione: senza, Giulia saprebbe dove si trova il veicolo di Marco.
    expect(giulia.received).toEqual([]);
    expect(marco.robotaxiStates()).toEqual(['ASSIGNED']);
  });

  it("l'operatore riceve gli eventi di flotta, anche quelli che nessuna corsa riguarda", async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const operatore = recordOperator(harness.sessions);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));
    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'MAINTENANCE', null));
    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'REBALANCING', null));

    expect(operatore.robotaxiStates()).toEqual(['ASSIGNED', 'MAINTENANCE', 'REBALANCING']);
    // Un evento che nessuna corsa riguarda non ha una categoria del RASD §2.2.3: arriva comunque,
    // con `type: null`, perché la dashboard sorveglia la flotta intera (R7, G8).
    expect(operatore.received.map((one) => one.type)).toEqual(['VEHICLE_ASSIGNED', null, null]);
  });

  it("l'operatore non riceve gli eventi di corsa, che sono del passeggero", async () => {
    const operatore = recordOperator(harness.sessions);
    const giulia = recordPassenger(harness.sessions, GIULIA);

    await harness.notifications.update({
      kind: 'RIDE_STATUS_CHANGED',
      occurredAt: AT,
      rideId: 'corsa-1',
      rideRequestId: 'richiesta-1',
      passengerId: GIULIA,
      robotaxiId: 'RT-01',
      status: 'IN_PROGRESS',
    });

    expect(giulia.rideStatuses()).toEqual(['IN_PROGRESS']);
    expect(operatore.received).toEqual([]);
  });

  it('lo storico si scrive solo per il passeggero, e solo se la notifica ha una categoria', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));
    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'MAINTENANCE', null));

    const written = harness.persistence.rowsOf('notification');
    // Una sola riga: la `Notification` del RASD §2.2.3 è indirizzata a un passeggero
    // (`Notification "0..*" --> "1" Passenger`), e l'evento di manutenzione non ne ha uno.
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      recipientId: GIULIA,
      rideRequestId: 'corsa-di-giulia',
      type: 'VEHICLE_ASSIGNED',
    });
    // La marca temporale è quella dell'**evento**, non quella della consegna: è ciò che permette a
    // un client che si riconnette di ricostruire quando le cose sono successe.
    expect(written[0]?.createdAt).toEqual(AT);
  });

  it('lo storico si scrive anche se nessuno è connesso', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));

    // È la ragione per cui la tabella esiste: chi riapre l'app ritrova ciò che è successo mentre
    // non c'era. Una push persa non lascia traccia da nessuna parte.
    expect(harness.persistence.rowsOf('notification')).toHaveLength(1);
  });
});

describe('[R6][NFR2] Il ciclo di vita delle sottoscrizioni', () => {
  it('alla disconnessione il subscriber viene rimosso e non restano riferimenti', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    const operatore = recordOperator(harness.sessions);

    expect(harness.sessions.registeredSessions()).toHaveLength(2);

    harness.sessions.removeSession(giulia.session);
    harness.sessions.removeSession(operatore.session);

    // Non «zero consegne», ma **zero riferimenti**: un observer che nessuno deregistra tiene in
    // vita la connessione morta, e il manager continua a spedirci sopra finché il processo dura.
    expect(harness.sessions.registeredSessions()).toEqual([]);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));
    expect(giulia.received).toEqual([]);
    expect(operatore.received).toEqual([]);
  });

  it('registrare due volte la stessa sessione non raddoppia le consegne', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    harness.sessions.registerSession(giulia.session);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));

    // Un client che ritenta la connessione non deve ricevere ogni evento due volte.
    expect(giulia.received).toHaveLength(1);
    expect(harness.sessions.registeredSessions()).toHaveLength(1);
  });

  it('deregistrare una sessione mai registrata non è un errore', () => {
    const giulia = recordPassenger(harness.sessions, GIULIA);
    harness.sessions.removeSession(giulia.session);

    // Una disconnessione può arrivare due volte, e la seconda non deve sollevare.
    expect(() => harness.sessions.removeSession(giulia.session)).not.toThrow();
  });

  it('due sessioni dello stesso passeggero ricevono entrambe', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const telefono = recordPassenger(harness.sessions, GIULIA);
    const tablet = recordPassenger(harness.sessions, GIULIA);

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));

    // Sono due connessioni distinte dello stesso utente: il filtro è sul passeggero, non sulla
    // sessione, e chiudere l'app sul telefono non deve zittire il tablet.
    expect(telefono.received).toHaveLength(1);
    expect(tablet.received).toHaveLength(1);
  });
});

describe('[R6][NFR5] Una consegna fallita non annulla la transizione che l ha generata', () => {
  /**
   * I guasti di questo blocco sono **iniettati apposta**, e il manager li registra: è ciò che deve
   * fare. Lasciarli stampare riempirebbe l'esecuzione di stack trace veri per errori finti, e una
   * suite verde che stampa errori è una suite che nessuno legge più — la stessa obiezione mossa al
   * cancello di M2 in questa milestone. Si zittisce il registro, non il comportamento.
   */
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('update() non solleva se lo storico non si scrive, e consegna lo stesso', async () => {
    // La richiesta esiste — quindi `recipientOf` la trova e si arriva davvero alla scrittura dello
    // storico — e **solo dopo** la scrittura si rompe. Rompendo `create` fin dall'inizio, la riga
    // di `ride_request` non esisterebbe, il destinatario sarebbe nullo e `create` non verrebbe mai
    // chiamata: il ramo che questo caso deve percorrere resterebbe intatto e il test passerebbe
    // anche cancellando il `try/catch` che sta verificando.
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    jest
      .spyOn(harness.persistence, 'create')
      .mockRejectedValue(new Error('database irraggiungibile'));

    // L'evento è **già accaduto**: la transizione è stata scritta prima che l'observer venisse
    // chiamato. Propagare l'errore trasformerebbe un guasto del canale nel fallimento di
    // un'operazione di dominio riuscita, e il chiamante disferebbe una corsa vera.
    await expect(
      harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia')),
    ).resolves.toBeUndefined();
    // Lo storico è perso, ma chi è connesso in questo momento la corsa la vede partire lo stesso.
    expect(giulia.robotaxiStates()).toEqual(['ASSIGNED']);
  });

  it("se il destinatario non si risolve, l'operatore vede comunque il veicolo muoversi", async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    const operatore = recordOperator(harness.sessions);
    jest
      .spyOn(harness.persistence, 'find')
      .mockRejectedValue(new Error('database irraggiungibile'));

    await expect(
      harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia')),
    ).resolves.toBeUndefined();

    // Senza il nome del destinatario non c'è né storico né consegna al passeggero, e non è
    // un'omissione: sono le due cose che di quel nome hanno bisogno. Il movimento del veicolo però
    // non dipende da chi sia il passeggero, e negarlo anche alla dashboard significherebbe far
    // pagare a chi guarda la flotta un guasto che riguarda un'altra tabella.
    expect(giulia.received).toEqual([]);
    expect(operatore.robotaxiStates()).toEqual(['ASSIGNED']);
  });

  it('e non solleva se una sessione esplode durante la consegna', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    jest.spyOn(giulia.session, 'pushToPassenger').mockImplementation(() => {
      throw new Error('socket chiusa');
    });

    await expect(
      harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia')),
    ).resolves.toBeUndefined();
  });

  it('una sessione rotta non zittisce le altre', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const rotta = recordPassenger(harness.sessions, GIULIA);
    const sana = recordPassenger(harness.sessions, GIULIA);
    const operatore = recordOperator(harness.sessions);
    jest.spyOn(rotta.session, 'pushToPassenger').mockImplementation(() => {
      throw new Error('socket chiusa');
    });

    await harness.notifications.update(robotaxiEvent('AVAILABLE', 'ASSIGNED', 'corsa-di-giulia'));

    // L'isolamento è **per sessione** e non per evento: con un solo `try` attorno al ciclo, la
    // prima socket rotta interromperebbe l'iterazione e negherebbe l'evento a tutti quelli dopo di
    // lei — gli operatori compresi, che vengono per ultimi. Un client rotto non zittisce gli altri.
    expect(sana.robotaxiStates()).toEqual(['ASSIGNED']);
    expect(operatore.robotaxiStates()).toEqual(['ASSIGNED']);
  });
});

describe('[R6][G7] Un fatto solo, una notifica sola', () => {
  it('il ritorno del veicolo fra i disponibili è un evento di flotta, non della corsa', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    const operatore = recordOperator(harness.sessions);

    // Fine corsa: il veicolo torna libero *avendo* una corsa in carico.
    await harness.notifications.update(robotaxiEvent('IN_RIDE', 'AVAILABLE', 'corsa-di-giulia'));

    // Il passeggero non riceve niente da **questo** evento: che la sua corsa sia finita glielo dice
    // la `Ride` passando a `COMPLETED`, nello stesso istante. Dando una categoria anche a questa
    // transizione riceverebbe due push con lo stesso testo, e la tabella `notification` prenderebbe
    // due righe per un fatto solo.
    expect(giulia.received).toEqual([]);
    expect(harness.persistence.rowsOf('notification')).toHaveLength(0);
    // La dashboard invece lo vede: per lei è il momento in cui quel veicolo torna disponibile.
    expect(operatore.robotaxiStates()).toEqual(['AVAILABLE']);
  });

  it('e lo stesso vale per un annullamento a veicolo assegnato', async () => {
    await givenRideRequest('corsa-di-giulia', GIULIA);
    const giulia = recordPassenger(harness.sessions, GIULIA);
    const operatore = recordOperator(harness.sessions);

    // Transizione 11: `cancel()` libera il veicolo, e subito dopo la corsa passa a `CANCELLED`.
    await harness.notifications.update(robotaxiEvent('ASSIGNED', 'AVAILABLE', 'corsa-di-giulia'));
    await harness.notifications.update({
      kind: 'RIDE_STATUS_CHANGED',
      occurredAt: AT,
      rideId: 'corsa-1',
      rideRequestId: 'corsa-di-giulia',
      passengerId: GIULIA,
      robotaxiId: 'RT-01',
      status: 'CANCELLED',
    });

    // Una sola notifica al passeggero, quella della corsa.
    expect(giulia.received).toHaveLength(1);
    expect(giulia.rideStatuses()).toEqual(['CANCELLED']);
    expect(harness.persistence.rowsOf('notification')).toHaveLength(1);
    // E un solo evento di flotta all'operatore: il veicolo che torna disponibile.
    expect(operatore.robotaxiStates()).toEqual(['AVAILABLE']);
  });
});
