import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  API_ROUTES,
  haversineKm,
  rideVehicleRoute,
  type GeoPoint,
  type RideRequestResponse,
  type UserRole,
} from '@road/shared';
import request from 'supertest';

import { GatewayModule } from '../../../src/gateway/gateway.module';
import { AllocationPort } from '../../../src/allocation/allocation.port';
import { FleetSimulationPort } from '../../../src/external/fleet-simulation.port';
import { ModePort } from '../../../src/mode/mode.port';
import { NotificationSessionPort } from '../../../src/notifications/session.port';
import {
  activationDueAt,
  PersistencePort,
  type NewRecord,
} from '../../../src/persistence/persistence.port';
import { ClockPort } from '../../../src/platform/clock.port';
import { RebalancingPort } from '../../../src/rebalancing/rebalancing.port';
import { AdvanceBookingActivatorPort } from '../../../src/rides/advance-booking.port';
import {
  BOARDING_SECONDS,
  FleetTelemetryPort,
  type TelemetryStep,
} from '../../../src/rides/fleet-telemetry.port';
import { recordOperator, recordPassenger } from '../../support/notifications';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * **I quattro scenari del RASD §2.1, dall'inizio alla fine** (MILESTONES.md §M9).
 *
 * Sono i test di sistema della milestone: non verificano un componente ma la storia che il RASD
 * racconta, dalla prima azione dell'attore all'ultima conseguenza. Ogni `describe` porta il nome
 * dello scenario e i requisiti che quella storia attraversa, così `pnpm trace` li attribuisce a chi
 * di dovere.
 *
 * **Dove passa il confine fra ciò che si guida e ciò che si osserva**, che è la sola scelta di
 * progetto di questo file:
 *
 * - ciò che fa un **attore** — Alice che richiede una corsa, Bob che prenota, Mark che cambia
 *   strategia — passa dall'**HTTP pubblico**, con un token e un ruolo, perché è esattamente il
 *   fenomeno condiviso che il RASD descrive. Un test che chiamasse le porte di dominio salterebbe
 *   la metà del percorso che riguarda l'attore: autenticazione, autorizzazione, contratto;
 * - ciò che fa il **sistema da sé** — attivare una prenotazione dovuta, leggere il traffico,
 *   leggere la telemetria, riposizionare — passa dalle porte, chiamando i `runOnce()` che in
 *   produzione chiama uno scheduler. Attendere che scattino significherebbe attendere l'orologio di
 *   sistema, che CLAUDE.md Regola 3 vieta proprio perché rende instabile una suite;
 * - ciò che fa il **mondo** — un veicolo che percorre una strada — passa da `tick()`, un passo alla
 *   volta, e quanti passi servano è una divisione e non un'attesa.
 *
 * Sotto c'è **Postgres vero** e ci sono gli **adapter veri** di M7: la stima dei percorsi in linea
 * d'aria (nessun OSRM configurato, che è la configurazione con cui il team lavora) e il simulatore
 * di flotta. **Serve Docker in esecuzione.**
 */

const HOOK_TIMEOUT_MS = 240_000;

/**
 * Un tick vale un chilometro: 20 km/h per 180 secondi di mondo simulato.
 *
 * I default sono un'altra cosa — mezzo secondo di tempo reale, tre secondi di mondo — e servono a
 * far *scorrere* i veicoli sulla mappa di chi guarda. Qui il passo si allarga perché ciò che questi
 * scenari raccontano è la **sequenza** degli eventi, non la grana del movimento: con il passo di
 * default una traversata di Milano costerebbe qualche centinaio di tick e il test parlerebbe di
 * aritmetica invece che della storia. La fisica verificata resta la stessa, ed è quella del
 * pacchetto (`tools/simulator/test`).
 */
const KM_PER_TICK = 1;

/** Lunedì 4 maggio 2026. Le ore cambiano da uno scenario all'altro. */
const MORNING = new Date('2026-05-04T08:00:00.000Z');

const DUOMO: GeoPoint = { lat: 45.4642, lon: 9.19 };
const CENTRALE: GeoPoint = { lat: 45.4863, lon: 9.205 };
const LINATE: GeoPoint = { lat: 45.4451, lon: 9.2767 };
const SAN_SIRO: GeoPoint = { lat: 45.4781, lon: 9.124 };
const NAVIGLI: GeoPoint = { lat: 45.45, lon: 9.175 };

const ZONES: readonly NewRecord<'zone'>[] = [
  { id: 'duomo', name: 'Duomo / Centro', ...DUOMO },
  { id: 'stazione-centrale', name: 'Stazione Centrale', ...CENTRALE },
  { id: 'san-siro', name: 'San Siro', ...SAN_SIRO },
  { id: 'navigli', name: 'Navigli / Darsena', ...NAVIGLI },
  { id: 'linate', name: 'Linate', ...LINATE },
];

const ALICE = {
  email: 'alice@example.com',
  password: 'password-di-prova',
  name: 'Alice',
  surname: 'Ferrari',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};

const BOB = { ...ALICE, email: 'bob@example.com', name: 'Bob', surname: 'Neri' };

const MARK = {
  ...ALICE,
  email: 'mark@example.com',
  name: 'Mark',
  surname: 'Verdi',
  role: 'OPERATOR' as const,
};

let harness: ApiHarness;
let api: INestApplication;

// Le porte del **medesimo** contenitore dell'applicazione: due composizioni distinte avrebbero due
// `NotificationManager`, con due registri di sessioni, e gli eventi finirebbero in quello che
// nessuno sta guardando.
let persistence: PersistencePort;
let allocation: AllocationPort;
let mode: ModePort;
let rebalancing: RebalancingPort;
let sessions: NotificationSessionPort;
let advanceBooking: AdvanceBookingActivatorPort;
let telemetry: FleetTelemetryPort;
let simulation: FleetSimulationPort;

interface Account {
  readonly id: string;
  readonly token: string;
}

/** Iscrive l'attore **dall'HTTP pubblico** e lo fa entrare: è il percorso di R1, non una scorciatoia. */
async function signUp(account: Omit<typeof ALICE, 'role'> & { role: UserRole }): Promise<Account> {
  if (account.role === 'OPERATOR') {
    // Il RASD prevede la registrazione dei soli passeggeri: un operatore esiste perché il seed lo
    // ha creato, e riprodurre quella condizione è ciò che rende lo scenario 3 realistico.
    await harness.auth.register(account);
  } else {
    await request(api.getHttpServer())
      .post(API_ROUTES.authRegister)
      .send({
        email: account.email,
        password: account.password,
        name: account.name,
        surname: account.surname,
      })
      .expect(201);
  }

  const response = await request(api.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email: account.email, password: account.password })
    .expect(200);

  const body = response.body as { accessToken: string; user: { id: string } };
  return { id: body.user.id, token: body.accessToken };
}

async function givenRobotaxi(id: string, at: GeoPoint, zoneId: string): Promise<void> {
  await persistence.create('robotaxi', {
    id,
    state: 'AVAILABLE',
    lat: at.lat,
    lon: at.lon,
    zoneId,
  });
}

async function stateOf(robotaxiId: string): Promise<string | undefined> {
  const [record] = await persistence.find('robotaxi', { where: { id: robotaxiId }, limit: 1 });
  return record?.state;
}

async function positionOf(robotaxiId: string): Promise<GeoPoint> {
  const [record] = await persistence.find('robotaxi', { where: { id: robotaxiId }, limit: 1 });
  if (record === undefined) throw new Error(`Nessun robotaxi ${robotaxiId}.`);
  return { lat: record.lat, lon: record.lon };
}

/** Quanti tick servono a coprire la distanza fra due punti, con un chilometro a tick. */
function ticksBetween(from: GeoPoint, to: GeoPoint): number {
  return Math.ceil(haversineKm(from, to) / KM_PER_TICK) + 1;
}

/**
 * Fa girare il mondo finché la corsa non compie il passo atteso, e restituisce quanti giri sono
 * serviti.
 *
 * Alterna un giro di telemetria e un tick del mondo, e conta i **tentativi** invece di attendere una
 * durata (HARNESS.md §2). Fallisce con un messaggio che dice quale passo non è arrivato: senza,
 * un'attesa esaurita direbbe soltanto «timeout», che è l'informazione con cui non si corregge nulla.
 */
async function driveUntil(rideRequestId: string, step: TelemetryStep): Promise<number> {
  const MAX_CYCLES = 200;
  const seen: TelemetryStep[] = [];

  for (let cycle = 1; cycle <= MAX_CYCLES; cycle += 1) {
    const outcome = await telemetry.runOnce();
    for (const progress of outcome.advanced) {
      if (progress.rideRequestId !== rideRequestId) continue;
      seen.push(progress.step);
      if (progress.step === step) return cycle;
    }
    simulation.tick();
  }

  throw new Error(
    `La corsa ${rideRequestId} non è arrivata a ${step} in ${MAX_CYCLES} giri. Passi osservati: ${seen.join(' → ') || '(nessuno)'}.`,
  );
}

/** Una richiesta immediata, fatta dal passeggero con il proprio token. */
async function requestImmediateRide(
  account: Account,
  pickup: GeoPoint,
  destination: GeoPoint,
): Promise<RideRequestResponse> {
  const response = await request(api.getHttpServer())
    .post(API_ROUTES.ridesImmediate)
    .set('Authorization', `Bearer ${account.token}`)
    .send({ pickup, destination })
    .expect(201);
  return response.body as RideRequestResponse;
}

beforeAll(async () => {
  // Gli adapter leggono l'ambiente **quando il modulo si compone**: va scritto prima.
  process.env.SIMULATOR_SPEED_KMH = '20';
  process.env.SIMULATOR_TICK_SECONDS = '180';

  harness = await startApiHarness(MORNING.toISOString());

  const moduleRef = await Test.createTestingModule({ imports: [GatewayModule] })
    .overrideProvider(ClockPort)
    .useValue(harness.clock)
    .compile();

  api = moduleRef.createNestApplication({ logger: false });
  await api.init();

  persistence = moduleRef.get(PersistencePort);
  allocation = moduleRef.get(AllocationPort);
  mode = moduleRef.get(ModePort);
  rebalancing = moduleRef.get(RebalancingPort);
  sessions = moduleRef.get(NotificationSessionPort);
  advanceBooking = moduleRef.get(AdvanceBookingActivatorPort);
  telemetry = moduleRef.get(FleetTelemetryPort);
  simulation = moduleRef.get(FleetSimulationPort);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await harness?.stop();

  // L'ambiente torna com'era: i file di integrazione condividono un worker Jest, e lasciare il
  // passo del simulatore a un valore da test accoppierebbe questo file ai successivi.
  delete process.env.SIMULATOR_SPEED_KMH;
  delete process.env.SIMULATOR_TICK_SECONDS;
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(MORNING);
  for (const zone of ZONES) await persistence.create('zone', zone);
});

describe('[R3][R5][R6][R7][G2][G4][G6][G7] Scenario 1 — Corsa immediata e ciclo di vita del veicolo', () => {
  /**
   * «Alice […] submits an immediate ride request […]. The system […] assign[s] the nearest available
   * robotaxi to her. The chosen robotaxi passes from the available state to the assigned state, and
   * Alice receives a notification […]. Shortly after, the robotaxi starts moving towards Alice's
   * pickup location, transiting to the arriving state […]. Once the vehicle reaches the pickup
   * location, it enters the arrived state […]. Alice boards the robotaxi, changing its state to
   * in-ride. Upon reaching the destination, Alice exits the vehicle, and the robotaxi becomes
   * available again.» (RASD §2.1, Scenario 1)
   */
  it('la storia di Alice, dalla richiesta al veicolo che torna disponibile', async () => {
    const alice = await signUp(ALICE);
    const suaApp = recordPassenger(sessions, alice.id);

    // Due veicoli, uno più vicino dell'altro: se l'assegnazione fosse arbitraria, «the nearest
    // available robotaxi» resterebbe una frase e non un'asserzione.
    await givenRobotaxi('RT-VICINO', { lat: DUOMO.lat + 0.004, lon: DUOMO.lon }, 'duomo');
    await givenRobotaxi('RT-LONTANO', SAN_SIRO, 'san-siro');

    const richiesta = await requestImmediateRide(alice, DUOMO, CENTRALE);

    expect(richiesta.status).toBe('ACCEPTED');
    expect(richiesta.assignedRobotaxiId).toBe('RT-VICINO');
    expect(await stateOf('RT-VICINO')).toBe('ASSIGNED');
    // L'altro non è stato toccato: un'assegnazione riguarda un veicolo solo.
    expect(await stateOf('RT-LONTANO')).toBe('AVAILABLE');

    // «Alice receives a notification on her app confirming the assignment.»
    expect(suaApp.robotaxiStates()).toEqual(['ASSIGNED']);

    // «Shortly after, the robotaxi starts moving towards Alice's pickup location.»
    await driveUntil(richiesta.id, 'PICKUP_NAVIGATION_STARTED');
    expect(await stateOf('RT-VICINO')).toBe('ARRIVING');

    // Il veicolo percorre la strada. Nessuna attesa: si contano i tick.
    simulation.tick(ticksBetween(await positionOf('RT-VICINO'), DUOMO));
    await driveUntil(richiesta.id, 'PICKUP_REACHED');
    expect(await stateOf('RT-VICINO')).toBe('ARRIVED');

    /*
     * «Alice boards the robotaxi, changing its state to in-ride.»
     *
     * Il RASD dice «Alice boards», e il sistema non ha modo di saperlo: la guardia
     * `isPassengerOnBoard()` è l'unica della Figura 2.10 che nessun sensore risolve, e la decisione
     * D63 la scioglie aspettando una sosta al punto di ritiro. La salita di Alice è quindi
     * **tempo che passa**, ed è così che il test la mette in scena — portando avanti l'orologio,
     * non contando giri.
     */
    harness.clock.advance(BOARDING_SECONDS * 1000);
    await driveUntil(richiesta.id, 'RIDE_STARTED');
    expect(await stateOf('RT-VICINO')).toBe('IN_RIDE');

    simulation.tick(ticksBetween(DUOMO, CENTRALE));
    await driveUntil(richiesta.id, 'RIDE_COMPLETED');

    // «the robotaxi becomes available again to serve new requests»: il ciclo si chiude dove è
    // cominciato, ed è ciò che rende la flotta una flotta invece di un elenco di veicoli occupati.
    expect(await stateOf('RT-VICINO')).toBe('AVAILABLE');

    const [conclusa] = await persistence.find('ride_request', {
      where: { id: richiesta.id },
      limit: 1,
    });
    expect(conclusa?.status).toBe('COMPLETED');

    // I quattro momenti che R6 elenca, nell'ordine, e nessun altro stato di mezzo.
    expect(suaApp.robotaxiStates()).toEqual(['ASSIGNED', 'ARRIVING', 'ARRIVED', 'IN_RIDE']);
    expect(suaApp.rideStatuses()).toContain('COMPLETED');
  });

  it('la posizione del veicolo resta leggibile per tutta la corsa, salita compresa', async () => {
    /*
     * L'app del passeggero disegna il robotaxi sulla mappa finché la corsa esiste, `in_ride`
     * compreso: il marker spariva proprio nell'istante in cui la corsa comincia, e una mappa che si
     * svuota mentre si viaggia sembra un'app che ha perso il segnale.
     *
     * Il pezzo che il backend deve garantire è che la rotta risponda **in ogni fase in cui un
     * veicolo mio esiste**, e che continui a non dire in che stato è (decisione D69): è la
     * proprietà su cui poggia la falsificabilità di NFR2, e si perde con la prima aggiunta fatta
     * in buona fede.
     */
    const alice = await signUp(ALICE);
    await givenRobotaxi('RT-01', { lat: DUOMO.lat + 0.004, lon: DUOMO.lon }, 'duomo');

    const richiesta = await requestImmediateRide(alice, DUOMO, CENTRALE);

    const dovEIlVeicolo = async (): Promise<GeoPoint | null> => {
      const response = await request(api.getHttpServer())
        .get(rideVehicleRoute(richiesta.id))
        .set('Authorization', `Bearer ${alice.token}`)
        .expect(200);
      const body = response.body as { vehicle: { position: GeoPoint } | null };
      // Nessuno stato, in nessuna fase: la progressione arriva dal canale push e solo da lì.
      expect(JSON.stringify(body)).not.toMatch(/"(state|status|robotaxiState|rideStatus)"/i);
      return body.vehicle?.position ?? null;
    };

    const assegnato = await dovEIlVeicolo();
    expect(assegnato).not.toBeNull();

    await driveUntil(richiesta.id, 'PICKUP_NAVIGATION_STARTED');
    expect(await dovEIlVeicolo()).not.toBeNull();

    simulation.tick(ticksBetween(await positionOf('RT-01'), DUOMO));
    await driveUntil(richiesta.id, 'PICKUP_REACHED');
    expect(await dovEIlVeicolo()).not.toBeNull();

    harness.clock.advance(BOARDING_SECONDS * 1000); // il passeggero sale (decisione D63)
    await driveUntil(richiesta.id, 'RIDE_STARTED');
    expect(await stateOf('RT-01')).toBe('IN_RIDE');

    // Il caso che conta: a bordo. E la posizione **si è mossa** rispetto all'assegnazione, cioè è
    // una posizione viva e non l'ultima riga scritta prima della partenza.
    simulation.tick(2);
    await telemetry.runOnce();
    const aBordo = await dovEIlVeicolo();
    expect(aBordo).not.toBeNull();
    expect(aBordo).not.toEqual(assegnato);
  });
});

describe('[R4][R6][G3][NFR4] Scenario 2 — Prenotazione anticipata', () => {
  /**
   * «Bob […] books a robotaxi in advance […] scheduling the pickup for 7:00 AM the following day.
   * The system […] selects a suitable robotaxi and **atomically reserves** its availability for the
   * required time interval […]. The next morning, shortly before the scheduled time, the system
   * activates the reservation. The selected robotaxi transitions from available to assigned and then
   * to arriving, and Bob is notified of the ride progress.» (RASD §2.1, Scenario 2)
   */
  const DOMANI_ALLE_SETTE = new Date('2026-05-05T05:00:00.000Z'); // 07:00 a Milano

  it('la storia di Bob, dalla prenotazione alla mattina dopo', async () => {
    const bob = await signUp(BOB);
    const suaApp = recordPassenger(sessions, bob.id);

    await givenRobotaxi('RT-01', { lat: DUOMO.lat + 0.004, lon: DUOMO.lon }, 'duomo');

    const prenotazione = (
      await request(api.getHttpServer())
        .post(API_ROUTES.ridesAdvance)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({
          pickup: DUOMO,
          destination: LINATE,
          scheduledPickup: DOMANI_ALLE_SETTE.toISOString(),
        })
        .expect(201)
    ).body as RideRequestResponse;

    expect(prenotazione.status).toBe('ACCEPTED');

    /*
     * **Una prenotazione non è un'assegnazione** (decisione D9). Il veicolo è *riservato*, non
     * assegnato: resta disponibile per le corse immediate di stanotte, ed è tutto il punto di
     * riservare una finestra invece di occupare un veicolo per dodici ore.
     */
    expect(prenotazione.assignedRobotaxiId).toBeNull();
    expect(await stateOf('RT-01')).toBe('AVAILABLE');

    // «atomically reserves its availability»: le due righe o ci sono entrambe o non c'è nessuna.
    expect(await harness.countRows('booking')).toBe(1);
    expect(await harness.countRows('robotaxi_reservation')).toBe(1);

    // La finestra è **limitata** da entrambi i capi: una riserva senza fine bloccherebbe ogni
    // prenotazione futura su quel veicolo (decisione D8).
    const [riserva] = await harness.query<{ lower: Date | null; upper: Date | null }>(
      'SELECT lower("period") AS lower, upper("period") AS upper FROM "robotaxi_reservation"',
    );
    expect(riserva?.lower).not.toBeNull();
    expect(riserva?.upper).not.toBeNull();

    // «The next morning, shortly before the scheduled time, the system activates the reservation.»
    // L'anticipo non se lo inventa il test: è quello con cui la prenotazione è stata scritta.
    const dovuta = activationDueAt(DOMANI_ALLE_SETTE);
    harness.clock.setNow(dovuta);

    const attivazione = await advanceBooking.runOnce();
    expect(attivazione.activations).toHaveLength(1);
    expect(attivazione.activations[0]?.outcome).toBe('ACTIVATED');
    expect(attivazione.activations[0]?.robotaxiId).toBe('RT-01');

    // «transitions from available to assigned…»
    expect(await stateOf('RT-01')).toBe('ASSIGNED');

    // «…and then to arriving, and Bob is notified of the ride progress.»
    await driveUntil(prenotazione.id, 'PICKUP_NAVIGATION_STARTED');
    expect(await stateOf('RT-01')).toBe('ARRIVING');
    expect(suaApp.robotaxiStates()).toEqual(['ASSIGNED', 'ARRIVING']);
  });

  it('se il veicolo riservato non è più idoneo, la prenotazione trova un altro veicolo', async () => {
    /*
     * Lo scenario dice «the *selected* robotaxi transitions», ma fra la sera e la mattina dopo
     * passano ore, e un veicolo può finire in manutenzione. Il RASD non descrive questo caso; il DD
     * lo chiude nella decisione D9, e senza questo test la promessa «la corsa di Bob parte comunque»
     * poggerebbe solo sul codice che dovrebbe mantenerla.
     */
    const bob = await signUp(BOB);
    await givenRobotaxi('RT-01', { lat: DUOMO.lat + 0.004, lon: DUOMO.lon }, 'duomo');

    const prenotazione = (
      await request(api.getHttpServer())
        .post(API_ROUTES.ridesAdvance)
        .set('Authorization', `Bearer ${bob.token}`)
        .send({
          pickup: DUOMO,
          destination: LINATE,
          scheduledPickup: DOMANI_ALLE_SETTE.toISOString(),
        })
        .expect(201)
    ).body as RideRequestResponse;

    // Nella notte arriva un secondo veicolo, e il primo va in officina.
    await givenRobotaxi('RT-02', { lat: DUOMO.lat + 0.006, lon: DUOMO.lon }, 'duomo');
    await harness.maintenance.requestMaintenance('RT-01', 'Freni');

    harness.clock.setNow(activationDueAt(DOMANI_ALLE_SETTE));
    const attivazione = await advanceBooking.runOnce();

    expect(attivazione.activations[0]?.outcome).toBe('REALLOCATED');
    expect(attivazione.activations[0]?.robotaxiId).toBe('RT-02');
    expect(await stateOf('RT-02')).toBe('ASSIGNED');

    const [attivata] = await persistence.find('ride_request', {
      where: { id: prenotazione.id },
      limit: 1,
    });
    expect(attivata?.assignedRobotaxiId).toBe('RT-02');
  });
});

describe('[R8][R12][R13][G5][NFR9][NFR10] Scenario 3 — Gestione automatica e manuale della strategia', () => {
  /**
   * «Mark is a Fleet Operator […] while the system is in Auto Mode. […] The system detects the
   * traffic level as Medium and displays a notification on Mark's dashboard suggesting a switch […].
   * Mark observes the situation but decides to remain in Auto Mode. As congestion continues to rise,
   * the system detects a High traffic level and automatically switches the active strategy to Minimum
   * ETA […]. Later, Mark […] manually selects the Nearest Available strategy. The system immediately
   * transitions to Manual Mode, suspending all automated strategy changes until Mark explicitly
   * re-enables Auto Mode via the dashboard interface.» (RASD §2.1, Scenario 3)
   */
  async function pannelloDiControllo(mark: Account): Promise<{
    mode: string;
    activeStrategy: string;
  }> {
    const response = await request(api.getHttpServer())
      .get(API_ROUTES.mode)
      .set('Authorization', `Bearer ${mark.token}`)
      .expect(200);
    return response.body as { mode: string; activeStrategy: string };
  }

  it('la giornata di Mark, dalla pioggia al ritorno in Auto', async () => {
    const mark = await signUp(MARK);
    const suaDashboard = recordOperator(sessions);

    // «while the system is in Auto Mode»: il default del RASD §2.4, letto dove Mark lo legge.
    expect(await pannelloDiControllo(mark)).toEqual({
      mode: 'AUTO',
      activeStrategy: 'NEAREST_AVAILABLE',
    });

    // «The system detects the traffic level as Medium and displays a notification on Mark's
    // dashboard suggesting a switch»: un suggerimento, **non** un cambio (R12).
    await mode.onTrafficLevel('MEDIUM');

    const alertDiTraffico = suaDashboard.received.filter(
      (evento) => evento.trafficLevel === 'MEDIUM',
    );
    expect(alertDiTraffico).toHaveLength(1);
    expect(alertDiTraffico[0]?.strategy).toBe('MINIMUM_ETA');
    // «Mark observes the situation but decides to remain in Auto Mode»: la strategia non si è mossa.
    expect(await pannelloDiControllo(mark)).toEqual({
      mode: 'AUTO',
      activeStrategy: 'NEAREST_AVAILABLE',
    });

    // «the system detects a High traffic level and automatically switches the active strategy»
    await mode.onTrafficLevel('HIGH');
    expect(await pannelloDiControllo(mark)).toEqual({
      mode: 'AUTO',
      activeStrategy: 'MINIMUM_ETA',
    });

    // «Later, Mark […] manually selects the Nearest Available strategy.» Dalla dashboard, cioè da
    // una richiesta autenticata con il ruolo di operatore: è la metà di R13 che il contratto fa
    // valere da solo.
    await request(api.getHttpServer())
      .put(API_ROUTES.allocationStrategy)
      .set('Authorization', `Bearer ${mark.token}`)
      .send({ strategy: 'NEAREST_AVAILABLE' })
      .expect(200);

    // «The system immediately transitions to Manual Mode»
    expect(await pannelloDiControllo(mark)).toEqual({
      mode: 'MANUAL',
      activeStrategy: 'NEAREST_AVAILABLE',
    });

    // «suspending all automated strategy changes»: il traffico continua a salire e non succede
    // nulla. È NFR10, ed è la sola asserzione di questo scenario che non si vede a schermo — la si
    // vede *non* accadendo, che è il tipo di proprietà che si perde per prima.
    await mode.onTrafficLevel('HIGH');
    await mode.onTrafficLevel('MEDIUM');
    await mode.onTrafficLevel('HIGH');
    expect(await pannelloDiControllo(mark)).toEqual({
      mode: 'MANUAL',
      activeStrategy: 'NEAREST_AVAILABLE',
    });

    // «until Mark explicitly re-enables Auto Mode via the dashboard interface»: e il rientro
    // **rivaluta subito** l'ultimo livello noto (decisione D11), che è High.
    const rientro = await request(api.getHttpServer())
      .put(API_ROUTES.mode)
      .set('Authorization', `Bearer ${mark.token}`)
      .send({ mode: 'AUTO' })
      .expect(200);

    expect(rientro.body).toEqual({ mode: 'AUTO', activeStrategy: 'MINIMUM_ETA' });
  });

  it('la scelta di Mark è riservata a Mark', async () => {
    // Il pannello strategia è dell'operatore: un passeggero non lo vede e non lo tocca (M1b). Senza
    // questo, «via the dashboard interface» sarebbe una frase sul luogo e non sull'autorità.
    const alice = await signUp(ALICE);

    await request(api.getHttpServer())
      .put(API_ROUTES.allocationStrategy)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ strategy: 'MINIMUM_ETA' })
      .expect(403);

    expect(await allocation.getActiveStrategy()).toBe('NEAREST_AVAILABLE');
  });
});

describe('[R10][R11][G9] Scenario 4 — Riposizionamento dinamico della flotta', () => {
  /**
   * «Late in the evening, a major concert ends at the city stadium. The system predicts this area as
   * a high-demand zone. […] It identifies several idle robotaxis scattered in low-demand areas of the
   * city and triggers their repositioning toward the stadium. Mark […] observes these rebalancing
   * movements on his monitor.» (RASD §2.1, Scenario 4)
   */
  const FINE_CONCERTO = new Date('2026-05-04T21:30:00.000Z'); // 23:30 a Milano

  /**
   * La sera del concerto: domanda di base bassa ovunque, l'evento allo stadio, e i veicoli fermi
   * **fuori** da San Siro.
   *
   * Due dettagli tengono in piedi lo scenario, e nessuno dei due è arbitrario.
   *
   * San Siro ha la base **più bassa** di tutte — mezza corsa attesa contro una: è uno stadio, e
   * fuori dagli eventi non ci va nessuno. Senza il concerto sarebbe l'ultima zona della classifica,
   * ed è ciò che impedisce allo scenario di passare per la ragione sbagliata, cioè per una zona che
   * sarebbe stata scelta comunque. A ribaltare l'ordine è il moltiplicatore dell'evento, che è tutto
   * il senso del modello a due livelli (decisione D12).
   *
   * Le zone di partenza hanno **tre** veicoli a fronte di una corsa attesa: una zona cede solo ciò
   * che le avanza dopo aver coperto la propria domanda arrotondata per eccesso, quindi con un
   * veicolo solo non cederebbe nulla e non ci sarebbe niente da mandare. «Idle robotaxis scattered
   * in low-demand areas» descrive proprio questo: zone che possono permetterselo, e possono farlo
   * più di una volta. Le altre due zone hanno esattamente i veicoli che la loro domanda chiede,
   * così **lo stadio è l'unica zona scoperta** e la classifica dei deficit non ha rivali:
   * l'asserzione parla del concerto e non della zona che per caso viene seconda.
   *
   * Restituisce gli identificatori della flotta, che il secondo caso deve poter togliere di scena.
   */
  async function givenLaSeraDelConcerto(): Promise<readonly string[]> {
    harness.clock.setNow(FINE_CONCERTO);

    // 23:30 di lunedì a Milano: `dayOfWeek 1`, `hourOfDay 23`. La conversione al fuso locale la fa
    // `analyzeDemand`, ed è la ragione per cui il campione va scritto sull'ora locale.
    const fascia = { dayOfWeek: 1, hourOfDay: 23 };
    for (const zone of ZONES) {
      await persistence.create('demand_sample', {
        zoneId: zone.id,
        ...fascia,
        baseDemand: zone.id === 'san-siro' ? 0.5 : 1,
      });
    }

    // «a major concert ends at the city stadium»: il secondo livello del modello di domanda.
    await persistence.create('demand_event', {
      zoneId: 'san-siro',
      name: 'Concerto allo stadio',
      startsAt: new Date(FINE_CONCERTO.getTime() - 3 * 60 * 60 * 1000),
      endsAt: new Date(FINE_CONCERTO.getTime() + 60 * 60 * 1000),
      multiplier: 8,
    });

    // «several idle robotaxis scattered in low-demand areas», e **nessuno** allo stadio.
    const flotta: readonly { id: string; at: GeoPoint; zoneId: string }[] = [
      { id: 'RT-NAVIGLI-1', at: NAVIGLI, zoneId: 'navigli' },
      { id: 'RT-NAVIGLI-2', at: { lat: NAVIGLI.lat + 0.001, lon: NAVIGLI.lon }, zoneId: 'navigli' },
      { id: 'RT-NAVIGLI-3', at: { lat: NAVIGLI.lat + 0.002, lon: NAVIGLI.lon }, zoneId: 'navigli' },
      { id: 'RT-DUOMO-1', at: DUOMO, zoneId: 'duomo' },
      { id: 'RT-DUOMO-2', at: { lat: DUOMO.lat + 0.001, lon: DUOMO.lon }, zoneId: 'duomo' },
      { id: 'RT-DUOMO-3', at: { lat: DUOMO.lat + 0.002, lon: DUOMO.lon }, zoneId: 'duomo' },
      { id: 'RT-CENTRALE', at: CENTRALE, zoneId: 'stazione-centrale' },
      { id: 'RT-LINATE', at: LINATE, zoneId: 'linate' },
    ];

    for (const veicolo of flotta) await givenRobotaxi(veicolo.id, veicolo.at, veicolo.zoneId);
    return flotta.map((veicolo) => veicolo.id);
  }

  it('la sera del concerto, i veicoli inattivi si muovono verso lo stadio', async () => {
    const mark = await signUp(MARK);
    const suaDashboard = recordOperator(sessions);

    await givenLaSeraDelConcerto();

    // «The system predicts this area as a high-demand zone.»
    const analisi = await rebalancing.analyzeDemand();
    expect(analisi.zones[0]?.zoneId).toBe('san-siro');
    // 0,5 × 8 batte l'1 di tutte le altre: la zona con la base più bassa finisce prima, e a
    // portarcela è stato l'evento.
    expect(analisi.zones[0]?.expectedDemand).toBe(4);
    expect(analisi.zones[0]?.availableRobotaxis).toBe(0);

    /*
     * «triggers their repositioning toward the stadium» — al **plurale**, e un ciclo manda un
     * veicolo per zona in deficit.
     *
     * Non è una limitazione da aggirare: il riposizionamento insegue una domanda *attesa*, e
     * svuotare le zone in surplus in un colpo solo per pareggiarla tutta scoprirebbe mezza città
     * per una previsione (`RebalancingPort.rebalance`). Più veicoli arrivano allo stadio perché il
     * ciclo si ripete, che è ciò che accade davvero: lo scheduler lo richiama.
     */
    const primo = await rebalancing.rebalance();
    const secondo = await rebalancing.rebalance();

    // Lo stadio è l'unica zona scoperta: tutto ciò che parte, parte per lì.
    const versoLoStadio = [...primo.dispatched, ...secondo.dispatched];
    expect(versoLoStadio.map((one) => one.targetZoneId)).toEqual(['san-siro', 'san-siro']);

    // Due veicoli distinti, e nessuno dei due preso da una zona che non poteva permetterselo.
    expect(new Set(versoLoStadio.map((one) => one.robotaxiId)).size).toBe(2);
    for (const invio of versoLoStadio) {
      expect(['navigli', 'duomo']).toContain(invio.fromZoneId);
    }

    for (const invio of versoLoStadio) {
      expect(await stateOf(invio.robotaxiId)).toBe('REBALANCING');
    }

    // «Mark […] observes these rebalancing movements on his monitor»: sul canale push arriva
    // l'annuncio, e la panoramica di flotta che disegna la mappa li conta.
    const annunci = suaDashboard.received.filter((evento) => evento.zoneId === 'san-siro');
    expect(annunci).toHaveLength(versoLoStadio.length);

    const panoramica = (
      await request(api.getHttpServer())
        .get(API_ROUTES.fleetStatus)
        .set('Authorization', `Bearer ${mark.token}`)
        .expect(200)
    ).body as { countsByState: Record<string, number> };

    expect(panoramica.countsByState.REBALANCING).toBe(versoLoStadio.length);
  });

  it('un veicolo che si sta riposizionando resta allocabile, e la corsa vince sul riposizionamento', async () => {
    /*
     * È il punto che rende utile la funzione, ed è facile da rompere senza accorgersene: un veicolo
     * mandato verso una zona di domanda prevista non è occupato — sta andando dove servirà — quindi
     * una corsa vera lo interrompe (`REBALANCING → ASSIGNED`, Figura 2.10). Se il riposizionamento
     * lo rendesse indisponibile, il sistema sottrarrebbe veicoli alla città per anticipare una
     * domanda che potrebbe non arrivare.
     */
    const alice = await signUp(ALICE);
    const flotta = await givenLaSeraDelConcerto();

    const piano = await rebalancing.rebalance();
    expect(piano.dispatched).toHaveLength(1);
    const inViaggio = piano.dispatched[0]?.robotaxiId as string;
    expect(await stateOf(inViaggio)).toBe('REBALANCING');

    /*
     * Gli altri veicoli escono di scena: con più candidati idonei la strategia sceglierebbe il più
     * vicino, e un test che passasse perché il veicolo in riposizionamento *era anche* il più
     * vicino non direbbe nulla sulla sua allocabilità. Resta un candidato solo, ed è quello in
     * viaggio verso lo stadio.
     */
    for (const altro of flotta) {
      if (altro === inViaggio) continue;
      await harness.maintenance.requestMaintenance(altro, 'Fuori scena per questo caso');
    }

    const richiesta = await requestImmediateRide(alice, NAVIGLI, DUOMO);

    expect(richiesta.status).toBe('ACCEPTED');
    expect(richiesta.assignedRobotaxiId).toBe(inViaggio);
    expect(await stateOf(inViaggio)).toBe('ASSIGNED');
  });
});
