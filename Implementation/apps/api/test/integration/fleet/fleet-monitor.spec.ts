import type { RobotaxiState as RobotaxiStateName } from '@road/shared';

import {
  IllegalTransitionError,
  UnknownRobotaxiError,
  type FleetMonitorPort,
} from '../../../src/fleet/fleet-monitor.port';
import type { MaintenancePort } from '../../../src/maintenance/maintenance.port';
import {
  immediateReservationWindow,
  type PersistencePort,
} from '../../../src/persistence/persistence.port';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * `FleetMonitor` e `MaintenanceManager` su un Postgres vero (HARNESS.md §1, passo 9).
 *
 * Tutto passa dalle porte. Il punto di questi test è ciò che i test unitari non possono mostrare:
 * che lo stato del veicolo **sopravvive al giro completo** — scrittura sulla colonna enum, rilettura,
 * ricostruzione dell'oggetto — e che il comportamento ricostruito è quello giusto. Su un doppio in
 * memoria lo stato sopravvivrebbe da solo, perché non andrebbe mai davvero via.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
const RIDE = { rideRequestId: 'sostituito-nel-beforeEach' };

const HOOK_TIMEOUT_MS = 180_000;

let harness: ApiHarness;
let fleet: FleetMonitorPort;
let maintenance: MaintenancePort;
let persistence: PersistencePort;

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  fleet = harness.fleet;
  maintenance = harness.maintenance;
  persistence = harness.persistence;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  await persistence.create('zone', { id: 'duomo', name: 'Duomo / Centro', ...DUOMO });
});

/** Un veicolo al Duomo, nello stato indicato. */
async function givenRobotaxi(id: string, state: RobotaxiStateName): Promise<string> {
  await persistence.create('robotaxi', { id, state, ...DUOMO, zoneId: 'duomo' });
  return id;
}

/** Una richiesta di corsa vera: serve a poter scrivere una riserva. */
async function givenRideRequest(email: string): Promise<string> {
  const passenger = await persistence.create('user', {
    email,
    passwordHash: 'non-una-password',
    name: 'Nome',
    surname: 'Cognome',
    phoneNumber: null,
    role: 'PASSENGER',
  });
  const request = await persistence.create('ride_request', {
    passengerId: passenger.id,
    kind: 'IMMEDIATE',
    status: 'PENDING',
    pickupLat: DUOMO.lat,
    pickupLon: DUOMO.lon,
    pickupAddress: null,
    destinationLat: 45.4781,
    destinationLon: 9.227,
    destinationAddress: null,
    assignedRobotaxiId: null,
  });
  return request.id;
}

/** Lo stato scritto in colonna, letto senza passare dal modulo. */
async function persistedState(id: string): Promise<string | undefined> {
  const rows = await harness.query<{ state: string }>(
    `SELECT "state" FROM "robotaxi" WHERE "id" = $1`,
    [id],
  );
  return rows[0]?.state;
}

describe('[R7][G8] Real-time Fleet Monitoring', () => {
  it('getFleetStatus riporta posizione e stato di ogni veicolo', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'IN_RIDE');
    await givenRobotaxi('RT-03', 'MAINTENANCE');

    const status = await fleet.getFleetStatus();

    expect(status.total).toBe(3);
    expect(status.robotaxis.map((robotaxi) => robotaxi.id)).toEqual(['RT-01', 'RT-02', 'RT-03']);
    expect(status.robotaxis[0]).toMatchObject({
      id: 'RT-01',
      state: 'AVAILABLE',
      lat: DUOMO.lat,
      lon: DUOMO.lon,
      zoneId: 'duomo',
    });
  });

  it('conta tutti e sette gli stati, anche quelli a zero', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'AVAILABLE');
    await givenRobotaxi('RT-03', 'REBALANCING');

    const status = await fleet.getFleetStatus();

    // Le colonne a zero ci sono: una status bar in cui una voce sparisce quando è vuota
    // costringerebbe il client a dedurre da sé l'insieme dei valori possibili (DD §3.2).
    expect(status.countsByState).toEqual({
      AVAILABLE: 2,
      ASSIGNED: 0,
      ARRIVING: 0,
      ARRIVED: 0,
      IN_RIDE: 0,
      REBALANCING: 1,
      MAINTENANCE: 0,
    });
  });

  it("data l'ora dall'orologio della piattaforma e non da quello di sistema", async () => {
    harness.clock.setNow(new Date('2026-05-04T18:30:00.000Z'));

    const status = await fleet.getFleetStatus();

    expect(status.observedAt.toISOString()).toBe('2026-05-04T18:30:00.000Z');
  });

  it('getAvailableRobotaxis restituisce i soli veicoli inattivi, in ordine di id', async () => {
    await givenRobotaxi('RT-03', 'AVAILABLE');
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'REBALANCING');

    // `REBALANCING` è allocabile ma non inattivo: mandarlo a riposizionarsi una seconda volta non
    // avrebbe senso, ed è questa la lista che il RebalancingManager di M6 userà come sorgente.
    expect((await fleet.getAvailableRobotaxis()).map((robotaxi) => robotaxi.id)).toEqual([
      'RT-01',
      'RT-03',
    ]);
  });
});

describe('[G6] getCandidates: chi può accettare una corsa', () => {
  it('include available e rebalancing, esclude tutti gli altri stati', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'REBALANCING');
    await givenRobotaxi('RT-03', 'ASSIGNED');
    await givenRobotaxi('RT-04', 'ARRIVING');
    await givenRobotaxi('RT-05', 'ARRIVED');
    await givenRobotaxi('RT-06', 'IN_RIDE');
    await givenRobotaxi('RT-07', 'MAINTENANCE');

    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual([
      'RT-01',
      'RT-02',
    ]);
  });

  it('con una finestra esclude anche chi ha già una riserva sovrapposta', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'AVAILABLE');
    const rideRequestId = await givenRideRequest('anna@example.com');
    const window = immediateReservationWindow(NOW, 5, 20);

    expect((await fleet.getCandidates(window)).map((robotaxi) => robotaxi.id)).toEqual([
      'RT-01',
      'RT-02',
    ]);

    await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId, window });

    // Il filtro sulla timeline è del PersistenceManager (DD §2.2): il FleetMonitor gli passa i
    // candidati e ne riceve indietro quelli liberi, senza tenere una seconda copia della verità.
    expect((await fleet.getCandidates(window)).map((robotaxi) => robotaxi.id)).toEqual(['RT-02']);

    // Fuori dalla finestra riservata il veicolo torna candidabile: la riserva è limitata (D8).
    const later = immediateReservationWindow(new Date('2026-05-04T14:00:00.000Z'), 5, 20);
    expect((await fleet.getCandidates(later)).map((robotaxi) => robotaxi.id)).toEqual([
      'RT-01',
      'RT-02',
    ]);
  });
});

describe('[G6][NFR5] Il ciclo di vita attraverso la porta', () => {
  it('assign scrive lo stato in colonna e lo restituisce', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    const rideRequestId = await givenRideRequest('anna@example.com');

    const assigned = await fleet.assign('RT-01', { ...RIDE, rideRequestId });

    expect(assigned.state).toBe('ASSIGNED');
    expect(await persistedState('RT-01')).toBe('ASSIGNED');
  });

  it('requestRebalancing porta a REBALANCING senza togliere il veicolo dai candidati', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');

    const rebalancing = await fleet.requestRebalancing('RT-01');

    expect(rebalancing.state).toBe('REBALANCING');
    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-01']);
  });

  it('rifiuta una transizione illegale senza toccare il database', async () => {
    await givenRobotaxi('RT-01', 'ARRIVED');
    const rideRequestId = await givenRideRequest('anna@example.com');

    await expect(fleet.assign('RT-01', { ...RIDE, rideRequestId })).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );

    // La transizione avviene prima della scrittura: se lo stato non l'ammette, il database non è
    // stato toccato e non serve nessuna compensazione (NFR5).
    expect(await persistedState('RT-01')).toBe('ARRIVED');
  });

  it('rifiuta un identificatore che non appartiene alla flotta', async () => {
    await expect(fleet.requestRebalancing('RT-99')).rejects.toBeInstanceOf(UnknownRobotaxiError);
  });
});

describe('[R9] Maintenance Management', () => {
  it('ferma il veicolo, apre lo storico e lo toglie dai candidati', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await givenRobotaxi('RT-02', 'AVAILABLE');

    const started = await maintenance.requestMaintenance('RT-01', 'freni');

    expect(started.robotaxi.state).toBe('MAINTENANCE');
    expect(started.record).toMatchObject({
      robotaxiId: 'RT-01',
      reason: 'freni',
      status: 'ONGOING',
      startedAt: NOW,
      endedAt: null,
    });

    // R9 alla lettera: «prevent their assignment to rides during such periods».
    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-02']);
    expect((await fleet.getAvailableRobotaxis()).map((robotaxi) => robotaxi.id)).toEqual(['RT-02']);
  });

  it('rimette in servizio il veicolo e chiude lo storico', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');
    await maintenance.requestMaintenance('RT-01', 'freni');
    harness.clock.setNow(new Date('2026-05-04T11:00:00.000Z'));

    const completed = await maintenance.completeMaintenance('RT-01');

    expect(completed.robotaxi.state).toBe('AVAILABLE');
    expect(completed.record).toMatchObject({
      status: 'COMPLETED',
      endedAt: new Date('2026-05-04T11:00:00.000Z'),
    });
    expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-01']);
  });

  it('non fa entrare in manutenzione un veicolo che si sta riposizionando', async () => {
    await givenRobotaxi('RT-01', 'REBALANCING');

    await expect(maintenance.requestMaintenance('RT-01', 'freni')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );

    // Né lo stato né lo storico: la transizione rifiutata non lascia mezzo lavoro dietro di sé.
    expect(await persistedState('RT-01')).toBe('REBALANCING');
    expect(await harness.countRows('maintenance_record')).toBe(0);
  });

  it('non chiude una manutenzione su un veicolo che non è fermo', async () => {
    await givenRobotaxi('RT-01', 'AVAILABLE');

    await expect(maintenance.completeMaintenance('RT-01')).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );
  });
});
