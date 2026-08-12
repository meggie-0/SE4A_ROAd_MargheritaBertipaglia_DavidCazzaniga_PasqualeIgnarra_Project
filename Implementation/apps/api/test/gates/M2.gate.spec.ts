import { ROBOTAXI_STATES, type RobotaxiState as RobotaxiStateName } from '@road/shared';

import type { FleetMonitorPort } from '../../src/fleet/fleet-monitor.port';
import {
  ALLOCATABLE_STATES,
  CANCELLABLE_STATES,
  IllegalTransitionError,
  ROBOTAXI_TRANSITIONS,
  Robotaxi,
  type RobotaxiTransition,
} from '../../src/fleet/robotaxi.port';
import type { MaintenancePort } from '../../src/maintenance/maintenance.port';
import type { PersistencePort } from '../../src/persistence/persistence.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M2 (MILESTONES.md §M2, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - copertura **esaustiva** della FSM a sette stati del DD §2.6.3, Figura 2.10: le tredici
 *     transizioni legali riescono e portano dove la figura dice, e **tutte** le altre
 *     (7 stati × 10 metodi − 13 = 57) sollevano `IllegalTransitionError`;
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

/** Le undici transizioni della Figura 2.10: `[da, transizione, a]`, nell'ordine della tabella. */
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
  // La 11 nasce con M4 **[v1.2]**: senza un'uscita da `ASSIGNED` verso `AVAILABLE`, R14 non è
  // realizzabile — l'annullamento deve poter restituire alla flotta un veicolo già assegnato.
  ['ASSIGNED', 'cancelRide', 'AVAILABLE'], // 11
  /**
   * Le 12 e 13 nascono con M7 **[v1.5]**, e completano R14 (decisione D59).
   *
   * La v1.2 le aveva escluse con una ragione precisa: fermare un veicolo già in movimento verso il
   * punto di ritiro richiede di **revocargli la rotta**, che è un comando alla flotta e non una
   * transizione del ciclo di vita — e `commandRoute()` non esisteva. Con M7 esiste, quindi la
   * ragione del divieto è venuta meno e il confine dell'annullamento è tornato dove R14 lo mette:
   * si annulla finché il passeggero non è a bordo. Da `IN_RIDE` resta vietato, e infatti quella
   * combinazione è ancora fra le illegali qui sotto.
   */
  ['ARRIVING', 'cancelRide', 'AVAILABLE'], // 12
  ['ARRIVED', 'cancelRide', 'AVAILABLE'], // 13
];

const legalKeys = new Set(LEGAL_TRANSITIONS.map(([from, transition]) => `${from}/${transition}`));

/** Le 57 combinazioni restanti: tutte quelle che la figura non elenca. */
const ILLEGAL_TRANSITIONS: ReadonlyArray<readonly [RobotaxiStateName, RobotaxiTransition]> =
  ROBOTAXI_STATES.flatMap((from) =>
    ROBOTAXI_TRANSITIONS.filter((transition) => !legalKeys.has(`${from}/${transition}`)).map(
      (transition): readonly [RobotaxiStateName, RobotaxiTransition] => [from, transition],
    ),
  );

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
/**
 * L'identificatore è un **uuid vero** anche se nessuna riga di `ride_request` gli corrisponde.
 *
 * Da M5 ogni transizione notifica, e il `NotificationManager` risale al passeggero cercando la
 * richiesta per identificatore: un valore che uuid non è fa rifiutare la query dal database. La
 * notifica non fallisce — `update()` non solleva mai, per non disfare una transizione riuscita — ma
 * ogni transizione di questo cancello lascerebbe uno stack trace nel registro, e un cancello verde
 * che stampa errori è un cancello che nessuno legge più. Che la richiesta non esista è invece
 * corretto e voluto: qui si prova la macchina a stati, non la catena delle corse.
 */
const RIDE = { rideRequestId: '00000000-0000-4000-8000-000000000001' };

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
    case 'cancelRide':
      return robotaxi.cancelRide();
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
    it('ha esattamente sette stati, dieci transizioni e tredici righe legali', () => {
      // Sette e non sei: la macchina autorevole è quella del DD, non quella del RASD §3.2. Se
      // qualcuno togliesse `REBALANCING` dall'enum condiviso, i conti qui sotto cambierebbero
      // senza che nessun altro test se ne accorgesse.
      expect(ROBOTAXI_STATES).toHaveLength(7);
      expect(ROBOTAXI_TRANSITIONS).toHaveLength(10);
      expect(LEGAL_TRANSITIONS).toHaveLength(13);
      expect(ILLEGAL_TRANSITIONS).toHaveLength(7 * 10 - 13);
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

  describe('[R9][G6] Allocabile significa una cosa sola', () => {
    it.each(ROBOTAXI_STATES)(
      'da %s, «è in ALLOCATABLE_STATES» ed «esce da assignRide senza errore» coincidono',
      (state) => {
        // `ALLOCATABLE_STATES` è una seconda scrittura di un fatto che sta già nelle classi di
        // stato, e due codifiche della stessa verità divergono se nessuno le lega. Senza questo
        // test, aggiungere `ARRIVED` all'elenco passerebbe il cancello: `getCandidates`
        // restituirebbe veicoli che poi rifiutano l'assegnazione.
        let assignable = true;
        try {
          vehicleIn(state).assignRide(RIDE);
        } catch {
          assignable = false;
        }

        expect(ALLOCATABLE_STATES.includes(state)).toBe(assignable);
      },
    );
  });

  describe('[R14][NFR5] Annullabile significa una cosa sola', () => {
    it.each(ROBOTAXI_STATES)(
      'da %s, «è in CANCELLABLE_STATES» ed «esce da cancelRide senza errore» coincidono',
      (state) => {
        // Stessa disciplina di `ALLOCATABLE_STATES`: l'elenco è una seconda scrittura di un fatto
        // che vive nelle classi di stato, e senza questo test le due copie divergerebbero in
        // silenzio — chi rifiuta un annullamento direbbe «troppo tardi» a un veicolo che invece
        // sarebbe ancora fermabile, o il contrario.
        let cancellable = true;
        try {
          vehicleIn(state).cancelRide();
        } catch {
          cancellable = false;
        }

        expect(CANCELLABLE_STATES.includes(state)).toBe(cancellable);
      },
    );

    it('un veicolo con il passeggero a bordo non si libera', () => {
      // È il confine di R14, e l'unico stato in cui l'annullamento resta rifiutato dopo M7: la
      // corsa comincia quando il passeggero sale (RASD §1.2.2).
      expect(CANCELLABLE_STATES).not.toContain('IN_RIDE');
      expect(() => vehicleIn('IN_RIDE').cancelRide()).toThrow(IllegalTransitionError);
    });
  });

  describe('[NFR5][G6] Lo stato sopravvive a persistenza e ricostruzione', () => {
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

    it('una transizione rifiutata non lascia nulla in colonna', async () => {
      // Lo stato di partenza è `ARRIVED` e non quello di arrivo della transizione richiesta:
      // altrimenti un'implementazione che scrivesse *prima* di transire lascerebbe in colonna lo
      // stesso valore, e l'asserzione non distinguerebbe le due implementazioni.
      await givenRobotaxi('RT-01', 'ARRIVED');

      await expect(fleet.assign('RT-01', RIDE)).rejects.toBeInstanceOf(IllegalTransitionError);

      expect(await persistedState('RT-01')).toBe('ARRIVED');
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
