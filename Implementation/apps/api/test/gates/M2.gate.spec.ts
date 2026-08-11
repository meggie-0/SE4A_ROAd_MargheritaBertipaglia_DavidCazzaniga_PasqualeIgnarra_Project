import { ROBOTAXI_STATES, type RobotaxiState as RobotaxiStateName } from '@road/shared';

import {
  IllegalTransitionError,
  ROBOTAXI_TRANSITIONS,
  Robotaxi,
  type FleetMonitorPort,
  type RobotaxiTransition,
} from '../../src/fleet/fleet-monitor.port';
import type { MaintenancePort } from '../../src/maintenance/maintenance.port';
import type { PersistencePort } from '../../src/persistence/persistence.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M2 (MILESTONES.md §M2, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - copertura **esaustiva** della FSM a sette stati del DD §2.6.3, Figura 2.10: le dieci
 *     transizioni legali riescono e portano dove la figura dice, e **tutte** le altre
 *     (7 stati × 9 metodi − 10 = 53) sollevano `IllegalTransitionError`;
 *   - lo stato sopravvive a un giro di persistenza e ricostruzione;
 *   - un veicolo in manutenzione è escluso dai candidati, uno in rebalancing no.
 *
 * La tabella qui sotto è trascritta dalla Figura 2.10 e non dedotta dal codice: un cancello che
 * ricavasse le transizioni legali interrogando le classi di stato passerebbe anche se una
 * transizione sparisse, cioè verificherebbe che il codice è d'accordo con sé stesso.
 *
 * **Serve Docker in esecuzione** per la parte su persistenza e candidati: che lo stato sopravviva a
 * una scrittura e a una rilettura è una proprietà del giro completo, e su un doppio in memoria
 * sopravvivrebbe da solo perché non andrebbe mai davvero via.
 */

/** Le dieci transizioni della Figura 2.10: `[da, transizione, a]`, nell'ordine della tabella. */
const LEGAL_TRANSITIONS: ReadonlyArray<
  readonly [RobotaxiStateName, RobotaxiTransition, RobotaxiStateName]
> = [
  ['AVAILABLE', 'requestMaintenance', 'MAINTENANCE'], // 1
  ['MAINTENANCE', 'completeMaintenance', 'AVAILABLE'], // 2
  ['AVAILABLE', 'assignRide', 'ASSIGNED'], // 3
  ['ASSIGNED', 'startPickupNavigation', 'ARRIVING'], // 4
  ['ARRIVING', 'pickupReached', 'ARRIVED'], // 5
  ['ARRIVED', 'startRide', 'IN_RIDE'], // 6
  ['IN_RIDE', 'completeRide', 'AVAILABLE'], // 7
  ['AVAILABLE', 'requestRebalancing', 'REBALANCING'], // 8
  ['REBALANCING', 'completeRebalancing', 'AVAILABLE'], // 9
  ['REBALANCING', 'assignRide', 'ASSIGNED'], // 10
];

const legalKeys = new Set(LEGAL_TRANSITIONS.map(([from, transition]) => `${from}/${transition}`));

/** Le 53 combinazioni restanti: tutte quelle che la figura non elenca. */
const ILLEGAL_TRANSITIONS: ReadonlyArray<readonly [RobotaxiStateName, RobotaxiTransition]> =
  ROBOTAXI_STATES.flatMap((from) =>
    ROBOTAXI_TRANSITIONS.filter((transition) => !legalKeys.has(`${from}/${transition}`)).map(
      (transition): readonly [RobotaxiStateName, RobotaxiTransition] => [from, transition],
    ),
  );

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
const RIDE = { rideRequestId: 'ride-1' };

const HOOK_TIMEOUT_MS = 180_000;

let harness: ApiHarness;
let fleet: FleetMonitorPort;
let maintenance: MaintenancePort;
let persistence: PersistencePort;

/** Un veicolo nello stato indicato, costruito senza toccare il database. */
function vehicleIn(state: RobotaxiStateName): Robotaxi {
  return new Robotaxi({
    id: 'RT-01',
    state,
    lat: DUOMO.lat,
    lon: DUOMO.lon,
    zoneId: 'duomo',
    updatedAt: NOW,
  });
}

/**
 * Chiama sul veicolo la transizione indicata.
 *
 * Uno `switch` in un test non è la macchina a stati scritta due volte: qui serve solo a passare da
 * un nome a una chiamata, e le nove voci vengono da `ROBOTAXI_TRANSITIONS`, quindi aggiungere un
 * decimo metodo senza aggiungerlo qui è un errore di compilazione.
 */
function invoke(robotaxi: Robotaxi, transition: RobotaxiTransition): void {
  switch (transition) {
    case 'assignRide':
      return robotaxi.assignRide(RIDE);
    case 'startPickupNavigation':
      return robotaxi.startPickupNavigation();
    case 'pickupReached':
      return robotaxi.pickupReached();
    case 'startRide':
      return robotaxi.startRide();
    case 'completeRide':
      return robotaxi.completeRide();
    case 'requestRebalancing':
      return robotaxi.requestRebalancing();
    case 'completeRebalancing':
      return robotaxi.completeRebalancing();
    case 'requestMaintenance':
      return robotaxi.requestMaintenance();
    case 'completeMaintenance':
      return robotaxi.completeMaintenance();
  }
}

async function givenRobotaxi(id: string, state: RobotaxiStateName): Promise<void> {
  await persistence.create('robotaxi', { id, state, ...DUOMO, zoneId: 'duomo' });
}

/** Lo stato scritto in colonna, letto senza passare dal modulo. */
async function persistedState(id: string): Promise<string | undefined> {
  const rows = await harness.query<{ state: string }>(
    `SELECT "state" FROM "robotaxi" WHERE "id" = $1`,
    [id],
  );
  return rows[0]?.state;
}

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

describe('[M2] Cancello: FleetMonitor e Robotaxi (State)', () => {
  describe('[NFR5][G6] La macchina a stati del DD §2.6.3, Figura 2.10', () => {
    it('ha esattamente sette stati e nove transizioni', () => {
      // Sette e non sei: la macchina autorevole è quella del DD, non quella del RASD §3.2. Se
      // qualcuno togliesse `REBALANCING` dall'enum condiviso, i conti qui sotto cambierebbero
      // senza che nessun altro test se ne accorgesse.
      expect(ROBOTAXI_STATES).toHaveLength(7);
      expect(ROBOTAXI_TRANSITIONS).toHaveLength(9);
      expect(LEGAL_TRANSITIONS).toHaveLength(10);
      expect(ILLEGAL_TRANSITIONS).toHaveLength(7 * 9 - 10);
    });

    it.each(LEGAL_TRANSITIONS)('%s --%s--> %s riesce', (from, transition, to) => {
      const robotaxi = vehicleIn(from);

      invoke(robotaxi, transition);

      expect(robotaxi.currentState).toBe(to);
    });

    it.each(ILLEGAL_TRANSITIONS)(
      '%s --%s--> solleva IllegalTransitionError',
      (from, transition) => {
        const robotaxi = vehicleIn(from);

        expect(() => invoke(robotaxi, transition)).toThrow(IllegalTransitionError);
        // E lascia lo stato dov'era: una transizione rifiutata non è una transizione a metà.
        expect(robotaxi.currentState).toBe(from);
      },
    );
  });

  describe('[G6] Lo stato sopravvive a persistenza e ricostruzione', () => {
    it('un giro completo su database porta il veicolo da available ad assigned', async () => {
      await givenRobotaxi('RT-01', 'AVAILABLE');

      // Transizione 8, scritta in colonna...
      await fleet.requestRebalancing('RT-01');
      expect(await persistedState('RT-01')).toBe('REBALANCING');

      // ...e poi la 10, che parte da un oggetto **ricostruito** dalla colonna: il FleetMonitor non
      // tiene niente in memoria fra le due chiamate, quindi l'unico modo perché questa riesca è
      // che `RobotaxiStateFactory` abbia rimesso in piedi il comportamento di `RebalancingState`.
      await fleet.assign('RT-01', RIDE);
      expect(await persistedState('RT-01')).toBe('ASSIGNED');
    });

    it('e con lo stato torna il comportamento, non solo il nome', async () => {
      await givenRobotaxi('RT-01', 'AVAILABLE');
      await fleet.assign('RT-01', RIDE);

      // Un veicolo già assegnato non si assegna una seconda volta. Se la ricostruzione riportasse
      // il solo nome dello stato, questa chiamata passerebbe e due passeggeri si troverebbero
      // sullo stesso veicolo.
      await expect(fleet.assign('RT-01', RIDE)).rejects.toBeInstanceOf(IllegalTransitionError);
      expect(await persistedState('RT-01')).toBe('ASSIGNED');
    });
  });

  describe('[R7][R9][G8] Chi compare fra i candidati', () => {
    it('un veicolo in manutenzione è escluso, uno in rebalancing no', async () => {
      await givenRobotaxi('RT-01', 'AVAILABLE');
      await givenRobotaxi('RT-02', 'AVAILABLE');
      await givenRobotaxi('RT-03', 'AVAILABLE');

      await fleet.requestRebalancing('RT-02');
      await maintenance.requestMaintenance('RT-03', 'freni');

      // I due punti che il DD §2.6.3 segnala come facili da sbagliare, in una riga sola.
      expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual([
        'RT-01',
        'RT-02',
      ]);

      const status = await fleet.getFleetStatus();
      expect(status.countsByState).toMatchObject({
        AVAILABLE: 1,
        REBALANCING: 1,
        MAINTENANCE: 1,
      });
    });

    it('il veicolo torna candidabile quando la manutenzione si chiude', async () => {
      await givenRobotaxi('RT-01', 'AVAILABLE');

      await maintenance.requestMaintenance('RT-01', 'freni');
      expect(await fleet.getCandidates()).toEqual([]);

      const completed = await maintenance.completeMaintenance('RT-01');

      expect(completed.record).toMatchObject({ status: 'COMPLETED', endedAt: NOW });
      expect((await fleet.getCandidates()).map((robotaxi) => robotaxi.id)).toEqual(['RT-01']);
    });
  });
});
