import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  API_ROUTES,
  NOTIFICATION_AUTH_FIELD,
  NOTIFICATION_EVENT,
  NOTIFICATIONS_NAMESPACE,
  type NotificationPush,
  type UserRole,
} from '@road/shared';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';

import { GatewayModule } from '../../src/gateway/gateway.module';
import { NotificationSessionPort } from '../../src/notifications/session.port';
import { PersistencePort } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { RideLifecyclePort } from '../../src/rides/ride-lifecycle.port';
import { RideRequestPort } from '../../src/rides/rides.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M5 (MILESTONES.md §M5, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - un passeggero connesso riceve `assigned → arriving → arrived → in_ride` **per la propria
 *     corsa** (R6, G7);
 *   - e **nessun** evento relativo a corse altrui;
 *   - un operatore riceve gli eventi di flotta;
 *   - alla disconnessione il subscriber viene rimosso e **non restano riferimenti**.
 *
 * Gira su **socket vere**, contro un server HTTP vero, sopra Postgres vero: **serve Docker in
 * esecuzione**. Non è pignoleria — ciò che questo cancello deve dimostrare è che la catena
 * *arriva al client*, e ogni pezzo sostituito con un doppio sposterebbe il confine della prova un
 * po' più indietro. Con un trasporto finto passerebbe anche una versione in cui l'handshake non
 * autentica, o in cui il subscriber non viene mai deregistrato.
 *
 * Le porte di dominio si prendono **dallo stesso `moduleRef` dell'applicazione**, non dall'harness:
 * il `NotificationManager` è un singleton *per processo Nest*, e due composizioni distinte ne
 * avrebbero due, con due registri di sessioni diversi. Gli eventi finirebbero in quello su cui
 * nessun client si è registrato — un difetto che non fa fallire niente e si manifesta come «le
 * notifiche non arrivano».
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };

/** Quante volte si riprova prima di dire che un messaggio non è arrivato (HARNESS.md §2). */
const MAX_ATTEMPTS = 150;

const GIULIA = {
  email: 'giulia.rossi@example.com',
  password: 'password-di-prova',
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};

const MARCO = { ...GIULIA, email: 'marco.bianchi@example.com', name: 'Marco' };

const OPERATORE = {
  ...GIULIA,
  email: 'ada.operatrice@example.com',
  name: 'Ada',
  role: 'OPERATOR' as const,
};

let harness: ApiHarness;
let api: INestApplication;
let baseUrl: string;

// Le porte del **medesimo** contenitore dell'applicazione.
let persistence: PersistencePort;
let rides: RideRequestPort;
let lifecycle: RideLifecyclePort;
let sessions: NotificationSessionPort;

/** Le socket aperte da un caso, chiuse dopo di esso: nessun test eredita le connessioni di un altro. */
let open: Socket[] = [];

async function givenRobotaxi(id: string, degrees: number): Promise<void> {
  await persistence.create('robotaxi', {
    id,
    state: 'AVAILABLE',
    lat: DUOMO.lat + degrees,
    lon: DUOMO.lon,
    zoneId: 'duomo',
  });
}

async function register(
  account: Omit<typeof GIULIA, 'role'> & { role: UserRole },
): Promise<{ id: string; token: string }> {
  const { user } = await harness.auth.register(account);
  const response = await request(api.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email: account.email, password: account.password })
    .expect(200);
  return { id: user.id, token: (response.body as { accessToken: string }).accessToken };
}

/** Un attimo di respiro per il ciclo di eventi. Si contano i **tentativi**, non i millisecondi. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

/**
 * Un client connesso al canale push, che accumula ciò che riceve.
 *
 * `waitFor(n)` riprova un numero fisso di volte invece di attendere una durata: un'attesa a tempo
 * rende la suite lenta quando va bene e instabile quando la macchina è carica.
 */
interface PushClient {
  readonly socket: Socket;
  readonly received: NotificationPush[];
  waitFor(count: number): Promise<NotificationPush[]>;
  robotaxiStates(): (NotificationPush['robotaxiState'] | null)[];
}

async function connect(token: string): Promise<PushClient> {
  const socket = io(`${baseUrl}${NOTIFICATIONS_NAMESPACE}`, {
    auth: { [NOTIFICATION_AUTH_FIELD]: token },
    transports: ['websocket'],
    forceNew: true,
  });
  open.push(socket);

  const received: NotificationPush[] = [];
  socket.on(NOTIFICATION_EVENT, (message: NotificationPush) => received.push(message));

  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });

  return {
    socket,
    received,
    async waitFor(count: number): Promise<NotificationPush[]> {
      for (let attempt = 0; attempt < MAX_ATTEMPTS && received.length < count; attempt += 1) {
        await tick();
      }
      return received;
    },
    robotaxiStates: () =>
      received.filter((one) => one.robotaxiState !== null).map((one) => one.robotaxiState),
  };
}

/** Attende che la socket risulti chiusa, o si arrende dopo un numero fisso di tentativi. */
async function waitUntilClosed(socket: Socket): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS && socket.connected; attempt += 1) await tick();
  return !socket.connected;
}

/** Attende che il registro del manager contenga esattamente `count` sessioni. */
async function waitForSessions(count: number): Promise<number> {
  for (
    let attempt = 0;
    attempt < MAX_ATTEMPTS && sessions.registeredSessions().length !== count;
    attempt += 1
  ) {
    await tick();
  }
  return sessions.registeredSessions().length;
}

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());

  const moduleRef = await Test.createTestingModule({ imports: [GatewayModule] })
    .overrideProvider(ClockPort)
    .useValue(harness.clock)
    .compile();

  api = moduleRef.createNestApplication({ logger: false });
  // `listen` e non solo `init`: senza un server HTTP vero Socket.IO non ha a cosa attaccarsi.
  await api.listen(0);
  baseUrl = (await api.getUrl()).replace('[::1]', '127.0.0.1');

  persistence = moduleRef.get(PersistencePort);
  rides = moduleRef.get(RideRequestPort);
  lifecycle = moduleRef.get(RideLifecyclePort);
  sessions = moduleRef.get(NotificationSessionPort);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  await persistence.create('zone', { id: 'duomo', name: 'Duomo / Centro', ...DUOMO });
});

afterEach(async () => {
  for (const socket of open) socket.disconnect();
  open = [];
  // Le sessioni se ne vanno con le socket: se un caso ne lasciasse una, il successivo vedrebbe
  // consegne che non ha chiesto e fallirebbe parlando d'altro.
  await waitForSessions(0);
});

describe('[M5] Cancello: NotificationManager (Observer) e push', () => {
  describe('[R6][G7][NFR2] Un passeggero connesso riceve la progressione della propria corsa', () => {
    it('assigned → arriving → arrived → in_ride, sul canale push', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const giulia = await register(GIULIA);
      const client = await connect(giulia.token);
      await waitForSessions(1);

      const outcome = await rides.submitImmediate({
        passengerId: giulia.id,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      expect(outcome.accepted).toBe(true);

      await lifecycle.startPickupNavigation(outcome.request.id);
      await lifecycle.pickupReached(outcome.request.id);
      await lifecycle.startRide(outcome.request.id);

      // Quattro eventi di veicolo più quelli di corsa: si attende il totale minimo e poi si
      // guardano solo gli stati del veicolo, che sono ciò che il criterio nomina.
      await client.waitFor(7);

      expect(client.robotaxiStates()).toEqual(['ASSIGNED', 'ARRIVING', 'ARRIVED', 'IN_RIDE']);
      // Le tre categorie che R6 nomina esplicitamente — «vehicle assignment, ETA, arrival at the
      // pickup point» — arrivano con il tipo del RASD §2.2.3.
      expect(client.received.map((one) => one.type)).toEqual(
        expect.arrayContaining(['VEHICLE_ASSIGNED', 'VEHICLE_ARRIVING', 'VEHICLE_ARRIVED']),
      );
      // Ogni messaggio rispetta il contratto pubblicato in `packages/shared`: è ciò che i client
      // di M8 useranno per validare senza importare una riga da `apps/api`.
      expect(client.received.every((one) => one.occurredAt === NOW.toISOString())).toBe(true);
    });

    it('e **nessun** evento relativo a corse altrui', async () => {
      await givenRobotaxi('RT-01', 0.01);
      await givenRobotaxi('RT-02', 0.05);
      const giulia = await register(GIULIA);
      const marco = await register(MARCO);

      const suo = await connect(giulia.token);
      const altrui = await connect(marco.token);
      await waitForSessions(2);

      // Corsa di Marco, e soltanto quella.
      const corsaDiMarco = await rides.submitImmediate({
        passengerId: marco.id,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      await lifecycle.startPickupNavigation(corsaDiMarco.request.id);
      await altrui.waitFor(3);

      // Marco vede la propria corsa...
      expect(altrui.robotaxiStates()).toEqual(['ASSIGNED', 'ARRIVING']);
      // ...e Giulia non vede niente. Se ricevesse anche un solo evento, saprebbe dove si trova il
      // veicolo che sta servendo un altro utente.
      expect(suo.received).toEqual([]);
    });
  });

  describe('[R7][G8] Un operatore riceve gli eventi di flotta', () => {
    it('di tutti i veicoli, comprese le corse di passeggeri diversi', async () => {
      await givenRobotaxi('RT-01', 0.01);
      await givenRobotaxi('RT-02', 0.05);
      const giulia = await register(GIULIA);
      const marco = await register(MARCO);
      const ada = await register(OPERATORE);

      const dashboard = await connect(ada.token);
      await waitForSessions(1);

      const prima = await rides.submitImmediate({
        passengerId: giulia.id,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      await rides.submitImmediate({
        passengerId: marco.id,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      await lifecycle.startPickupNavigation(prima.request.id);
      await dashboard.waitFor(3);

      // Due veicoli diversi, tre movimenti: la dashboard li vede tutti (R7, G8).
      expect(dashboard.received.map((one) => one.robotaxiId)).toEqual(['RT-01', 'RT-02', 'RT-01']);
      expect(dashboard.robotaxiStates()).toEqual(['ASSIGNED', 'ASSIGNED', 'ARRIVING']);
      // Nessuno stato di corsa: quelli sono del passeggero. L'operatore vede la stessa
      // progressione dal lato del veicolo, che è la vista che gli compete.
      expect(dashboard.received.every((one) => one.rideStatus === null)).toBe(true);
    });
  });

  describe('[R6][NFR2] Il ciclo di vita delle sottoscrizioni', () => {
    it('alla disconnessione il subscriber viene rimosso e non restano riferimenti', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const giulia = await register(GIULIA);
      const ada = await register(OPERATORE);

      const passeggero = await connect(giulia.token);
      const dashboard = await connect(ada.token);
      expect(await waitForSessions(2)).toBe(2);

      passeggero.socket.disconnect();
      expect(await waitForSessions(1)).toBe(1);

      dashboard.socket.disconnect();
      // **Zero riferimenti**, non «zero consegne»: un observer che nessuno deregistra tiene in
      // vita la connessione morta, e il manager continua a spedirci sopra finché il processo dura.
      expect(await waitForSessions(0)).toBe(0);
      expect(sessions.registeredSessions()).toEqual([]);

      // E dopo la disconnessione nulla arriva più: la sessione non è solo assente dal registro,
      // è davvero staccata dalla catena.
      const quanti = passeggero.received.length;
      await rides.submitImmediate({
        passengerId: giulia.id,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      await tick();
      expect(passeggero.received).toHaveLength(quanti);
    });

    it('un handshake senza token valido non apre nessuna sessione', async () => {
      const rifiutata = io(`${baseUrl}${NOTIFICATIONS_NAMESPACE}`, {
        auth: { [NOTIFICATION_AUTH_FIELD]: 'non-e-un-token' },
        transports: ['websocket'],
        forceNew: true,
      });
      open.push(rifiutata);

      // Il server chiude la connessione: ogni evento che viaggia su questo canale riguarda
      // qualcuno, quindi un canale anonimo non esiste.
      expect(await waitUntilClosed(rifiutata)).toBe(true);
      expect(sessions.registeredSessions()).toEqual([]);
    });

    it('e nemmeno un handshake che il token non lo porta affatto', async () => {
      const anonima = io(`${baseUrl}${NOTIFICATIONS_NAMESPACE}`, {
        transports: ['websocket'],
        forceNew: true,
      });
      open.push(anonima);

      expect(await waitUntilClosed(anonima)).toBe(true);
      expect(sessions.registeredSessions()).toEqual([]);
    });
  });

  describe('[R14][R6] Un fatto solo, una notifica sola', () => {
    it("l'annullamento a veicolo assegnato non manda due volte lo stesso messaggio", async () => {
      await givenRobotaxi('RT-01', 0.01);
      const giulia = await register(GIULIA);
      const ada = await register(OPERATORE);
      const client = await connect(giulia.token);
      const dashboard = await connect(ada.token);
      await waitForSessions(2);

      const outcome = await rides.submitImmediate({
        passengerId: giulia.id,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      await client.waitFor(2);
      client.received.length = 0;
      dashboard.received.length = 0;

      await rides.cancel(outcome.request.id, giulia.id);
      await client.waitFor(1);

      /**
       * L'annullamento produce **due** eventi di dominio — il veicolo torna `AVAILABLE`
       * (transizione 11) e la corsa passa a `CANCELLED` — e sono due fatti diversi per due
       * pubblici diversi. Al passeggero ne arriva **uno solo**: che la sua corsa è finita. Il
       * ritorno del veicolo fra i disponibili è un movimento di flotta e riguarda la dashboard.
       *
       * Senza questa distinzione il passeggero riceverebbe due push con lo stesso identico testo
       * e la tabella `notification` prenderebbe due righe per un fatto solo.
       */
      expect(client.received).toHaveLength(1);
      expect(client.received[0]?.rideStatus).toBe('CANCELLED');

      expect(dashboard.robotaxiStates()).toEqual(['AVAILABLE']);

      const written = await persistence.find('notification', {
        where: { recipientId: giulia.id, rideRequestId: outcome.request.id },
      });
      expect(written.filter((row) => row.message.includes('annullata'))).toHaveLength(1);
    });
  });

  describe('[R6][G7] Lo storico sopravvive alla disconnessione', () => {
    it('ciò che accade mentre il client è assente resta scritto', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const giulia = await register(GIULIA);

      // Nessuno connesso: la corsa parte e avanza comunque.
      const outcome = await rides.submitImmediate({
        passengerId: giulia.id,
        pickup: DUOMO,
        destination: CENTRALE,
      });
      await lifecycle.startPickupNavigation(outcome.request.id);

      const written = await persistence.find('notification', {
        where: { recipientId: giulia.id },
        orderBy: [{ field: 'createdAt' }, { field: 'type' }],
      });

      // È la ragione per cui la tabella `notification` esiste accanto al canale: il canale
      // consegna a chi c'è, la tabella conserva per chi torna.
      expect(written.map((row) => row.type)).toEqual(
        expect.arrayContaining(['VEHICLE_ASSIGNED', 'VEHICLE_ARRIVING']),
      );
      expect(written.every((row) => row.recipientId === giulia.id)).toBe(true);
    });
  });
});
