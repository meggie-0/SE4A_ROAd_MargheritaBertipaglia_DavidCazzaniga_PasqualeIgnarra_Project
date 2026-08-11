import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { API_ROUTES, STRATEGY_NAMES, type StrategyName } from '@road/shared';
import request from 'supertest';

import {
  AllocationStrategy,
  bestScored,
  type AllocationRequest,
} from '../../src/allocation/allocation.port';
import type { RobotaxiSnapshot } from '../../src/fleet/robotaxi.port';
import { GatewayModule } from '../../src/gateway/gateway.module';
import { SYSTEM_MODE_ID } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { composeAllocation, type AllocationHarness } from '../support/allocation';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M3 (MILESTONES.md §M3, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - **per ciascuna strategia**: flotta vuota → nessuna assegnazione; nessun candidato idoneo →
 *     nessuna assegnazione; un solo idoneo → quello; più candidati → il corretto secondo la
 *     metrica; valori di frontiera su distanza ed ETA; pareggi risolti in modo deterministico;
 *   - aggiungere una terza strategia fittizia richiede **una classe e una registrazione** (NFR7);
 *   - l'operatore legge e cambia la strategia a runtime, e il cambio è visibile ovunque (R8, G5).
 *
 * Le due parti girano su composizioni diverse, e non per comodità. La scelta del veicolo è una
 * proprietà del dominio: si prova passando candidati e tabelle di ETA a mano, perché è l'unico modo
 * di costruire il caso che conta — il veicolo lontano che arriva prima — e perché un database non
 * aggiungerebbe nulla alla dimostrazione. Che la strategia attiva sia scritta su una colonna e
 * cambiabile a sistema acceso è invece una proprietà del sistema *intero*, e quella si verifica su
 * HTTP vero con Postgres vero: **serve Docker in esecuzione**.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;
const DUOMO = { lat: 45.4642, lon: 9.19 };
const REQUEST: AllocationRequest = { pickup: DUOMO };

function robotaxiAt(id: string, lat: number, lon = DUOMO.lon): RobotaxiSnapshot {
  return { id, state: 'AVAILABLE', lat, lon, zoneId: null, updatedAt: NOW };
}

/** Un veicolo a `degrees` gradi di latitudine a nord del Duomo (0,01° ≈ 1,1 km). */
const north = (id: string, degrees: number): RobotaxiSnapshot =>
  robotaxiAt(id, DUOMO.lat + degrees);

// -------------------------------------------------------------------------------------------
// I casi, uno per strategia
// -------------------------------------------------------------------------------------------

/**
 * Il banco di prova di una strategia: la tabella degli ETA che vale per tutti i suoi casi e, per
 * ciascun criterio del cancello, i candidati e il vincitore atteso.
 *
 * Ogni strategia porta i propri numeri perché ogni strategia ha la propria metrica: è il punto del
 * pattern. Ciò che resta comune è l'elenco dei criteri, che è quello di MILESTONES.md §M3.
 */
interface StrategyCase {
  readonly strategy: StrategyName;
  readonly eta: Readonly<Record<string, number>>;
  /** Un solo candidato idoneo: dev'essere scelto lui, per quanto scomodo sia. */
  readonly single: readonly RobotaxiSnapshot[];
  /** Candidati che la metrica non sa valutare: nessuna assegnazione. */
  readonly noneEligible: readonly RobotaxiSnapshot[];
  /** Tre candidati distinguibili: vince `RT-03`. */
  readonly many: readonly RobotaxiSnapshot[];
  /** Due candidati a un passo di distanza sulla metrica: vince `RT-02`. */
  readonly boundary: readonly RobotaxiSnapshot[];
  /** Tre candidati a pari merito: vince l'id minore, `RT-02`. */
  readonly tie: readonly RobotaxiSnapshot[];
}

const CASES: readonly StrategyCase[] = [
  {
    strategy: 'NEAREST_AVAILABLE',
    // La distanza il sistema la conosce da sé: nessun ETA serve, e infatti la tabella è vuota.
    eta: {},
    single: [north('RT-09', 0.09)],
    // Un veicolo la cui posizione non è un numero — telemetria mancante — non ha una distanza
    // confrontabile, quindi non è idoneo. È l'unico modo in cui un candidato può risultare
    // inidoneo *a questa* metrica: lo stato del veicolo e la sua libertà nella finestra li hanno
    // già decisi `FleetMonitor` e `filterAvailable` prima di arrivare qui.
    noneEligible: [robotaxiAt('RT-01', Number.NaN, Number.NaN)],
    many: [north('RT-01', 0.05), north('RT-02', 0.03), north('RT-03', 0.01)],
    // Un centomillesimo di grado: poco più di un metro. Se la distanza venisse arrotondata, i
    // due sembrerebbero pari merito e vincerebbe RT-01 per via dell'id.
    boundary: [north('RT-01', 0.01001), north('RT-02', 0.01)],
    tie: [north('RT-07', 0.02), north('RT-02', 0.02), north('RT-05', 0.02)],
  },
  {
    strategy: 'MINIMUM_ETA',
    eta: {
      'RT-09': 33,
      'RT-01': 22,
      'RT-02': 7,
      'RT-03': 4,
      'RT-05': 7,
      'RT-07': 7,
      'RT-11': 7.1,
    },
    single: [north('RT-09', 0.09)],
    // Di questi veicoli il fornitore non sa dire nulla: non compaiono nel suo esito. Assegnarne
    // uno significherebbe promettere al passeggero un'attesa che nessuno ha calcolato.
    noneEligible: [north('RT-40', 0.01), north('RT-41', 0.02)],
    // Le posizioni contraddicono gli ETA di proposito: RT-03 è il più lontano dei tre ed è quello
    // che arriva prima. Una strategia che guardasse la distanza sceglierebbe RT-01.
    many: [north('RT-01', 0.005), north('RT-02', 0.02), north('RT-03', 0.06)],
    // Un decimo di minuto: se gli ETA venissero arrotondati al minuto, vincerebbe RT-02 per l'id
    // invece che per la metrica — e il test non distinguerebbe le due implementazioni. Qui vince
    // comunque RT-02, ma per il motivo giusto: RT-11 ha l'id maggiore *e* l'ETA maggiore.
    boundary: [north('RT-11', 0.01), north('RT-02', 0.01)],
    tie: [north('RT-07', 0.01), north('RT-02', 0.04), north('RT-05', 0.02)],
  },
];

// -------------------------------------------------------------------------------------------
// La terza strategia: una classe, e nient'altro (NFR7)
// -------------------------------------------------------------------------------------------

/**
 * Una politica inventata per il cancello: «il veicolo più a nord».
 *
 * È scritta qui, in un file di test, estendendo la sola classe astratta che `allocation` pubblica.
 * Non conosce `AllocationManager`, non tocca `allocation.module.ts` e non richiede un metodo nuovo
 * su nessuna porta: è la forma che NFR7 promette — «una classe e una registrazione».
 *
 * Il nome resta una stringa nuda, e la conversione a `StrategyName` compare **una volta sola**, nel
 * punto in cui la classe astratta la pretende. È anche la misura esatta di ciò che NFR7 *non*
 * copre: una politica vera in più richiede il suo nome in `STRATEGY_NAMES` e una migrazione della
 * colonna `system_mode.active_strategy`, che da quella tupla ha generato il vincolo `CHECK`.
 */
const NORTHERNMOST = 'NORTHERNMOST_FIRST';

class NorthernmostStrategy extends AllocationStrategy {
  readonly name = NORTHERNMOST as StrategyName;

  selectRobotaxi(
    _request: AllocationRequest,
    candidates: readonly RobotaxiSnapshot[],
  ): Promise<RobotaxiSnapshot | null> {
    // Anche la regola dei pareggi è riusabile: `bestScored` sceglie il punteggio minore e rompe
    // le parità sull'id crescente, così una politica nuova nasce deterministica.
    return Promise.resolve(
      bestScored(candidates.map((robotaxi) => ({ robotaxi, score: -robotaxi.lat }))),
    );
  }
}

// -------------------------------------------------------------------------------------------
// Il cancello
// -------------------------------------------------------------------------------------------

let harness: ApiHarness;
let api: INestApplication;
let operatorToken: string;

const OPERATOR = {
  email: 'ada.operatrice@example.com',
  password: 'password-operatrice',
  name: 'Ada',
  surname: 'Operatrice',
  phoneNumber: null,
  role: 'OPERATOR' as const,
};

const PASSENGER = {
  email: 'giulia.rossi@example.com',
  password: 'password-di-prova',
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};

/** Fa il login attraverso l'HTTP pubblico e restituisce l'access token. */
async function login(email: string, password: string): Promise<string> {
  const response = await request(api.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email, password })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());

  const moduleRef = await Test.createTestingModule({ imports: [GatewayModule] })
    .overrideProvider(ClockPort)
    .useValue(harness.clock)
    .compile();
  api = moduleRef.createNestApplication({ logger: false });
  await api.init();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  await harness.auth.register(OPERATOR);
  operatorToken = await login(OPERATOR.email, OPERATOR.password);
});

describe('[M3] Cancello: AllocationManager e strategie (Strategy)', () => {
  describe('[R5][G4] Ogni strategia, sui casi che il cancello elenca', () => {
    /** Il modulo composto con la strategia del caso già attiva e la sua tabella di ETA. */
    async function given(testCase: StrategyCase): Promise<AllocationHarness> {
      return composeAllocation({
        activeStrategy: testCase.strategy,
        etaMinutes: testCase.eta,
        now: NOW,
      });
    }

    /** Esegue `check` su una composizione fresca e la chiude comunque vada. */
    async function withStrategy(
      testCase: StrategyCase,
      check: (allocation: AllocationHarness) => Promise<void>,
    ): Promise<void> {
      const composed = await given(testCase);
      try {
        await check(composed);
      } finally {
        await composed.close();
      }
    }

    it('i casi coprono tutte le strategie registrate dal modulo, nessuna esclusa', async () => {
      // Se un giorno il modulo ne registrasse una terza senza aggiungerla qui, il cancello
      // continuerebbe a passare provandone due su tre: è il modo in cui una copertura
      // «esaustiva» smette di esserlo senza che nessuno se ne accorga.
      const composed = await composeAllocation({ now: NOW });
      try {
        expect([...composed.registeredStrategies].sort()).toEqual([...STRATEGY_NAMES].sort());
        expect(CASES.map((testCase) => testCase.strategy).sort()).toEqual(
          [...STRATEGY_NAMES].sort(),
        );
      } finally {
        await composed.close();
      }
    });

    it.each(CASES)('$strategy: flotta vuota → nessuna assegnazione', async (testCase) => {
      await withStrategy(testCase, async ({ allocation }) => {
        expect(await allocation.allocate(REQUEST, [])).toBeNull();
      });
    });

    it.each(CASES)(
      '$strategy: nessun candidato idoneo → nessuna assegnazione',
      async (testCase) => {
        await withStrategy(testCase, async ({ allocation }) => {
          expect(await allocation.allocate(REQUEST, testCase.noneEligible)).toBeNull();
        });
      },
    );

    it.each(CASES)('$strategy: un solo candidato idoneo → quello', async (testCase) => {
      await withStrategy(testCase, async ({ allocation }) => {
        const chosen = await allocation.allocate(REQUEST, testCase.single);
        expect(chosen?.id).toBe('RT-09');
      });
    });

    it.each(CASES)(
      '$strategy: più candidati → il migliore secondo la metrica',
      async (testCase) => {
        await withStrategy(testCase, async ({ allocation }) => {
          const chosen = await allocation.allocate(REQUEST, testCase.many);
          expect(chosen?.id).toBe('RT-03');

          // E l'ordine in cui i candidati arrivano non conta: l'ordinamento è totale.
          const reversed = [...testCase.many].reverse();
          expect((await allocation.allocate(REQUEST, reversed))?.id).toBe('RT-03');
        });
      },
    );

    it.each(CASES)('$strategy: valori di frontiera sulla metrica', async (testCase) => {
      await withStrategy(testCase, async ({ allocation }) => {
        const chosen = await allocation.allocate(REQUEST, testCase.boundary);
        expect(chosen?.id).toBe('RT-02');
      });
    });

    it.each(CASES)('$strategy: pareggio risolto sull id crescente', async (testCase) => {
      await withStrategy(testCase, async ({ allocation }) => {
        expect((await allocation.allocate(REQUEST, testCase.tie))?.id).toBe('RT-02');

        const reversed = [...testCase.tie].reverse();
        expect((await allocation.allocate(REQUEST, reversed))?.id).toBe('RT-02');
      });
    });

    it('le due metriche non sono la stessa metrica scritta due volte', async () => {
      // Senza questo caso l'intero cancello passerebbe anche se `MinimumEtaStrategy` misurasse la
      // distanza: qui il veicolo più vicino è il più lento, e le due politiche devono scegliere
      // due veicoli diversi. È la ragione per cui il sistema ha due politiche (RASD §2.4).
      const candidates = [north('RT-01', 0.005), north('RT-02', 0.08)];
      const eta = { 'RT-01': 30, 'RT-02': 5 };

      const nearest = await composeAllocation({
        activeStrategy: 'NEAREST_AVAILABLE',
        etaMinutes: eta,
        now: NOW,
      });
      const minimumEta = await composeAllocation({
        activeStrategy: 'MINIMUM_ETA',
        etaMinutes: eta,
        now: NOW,
      });

      try {
        expect((await nearest.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-01');
        expect((await minimumEta.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-02');
      } finally {
        await nearest.close();
        await minimumEta.close();
      }
    });
  });

  describe('[NFR7] Una politica nuova è una classe e una registrazione', () => {
    it('la terza strategia viene eseguita senza modificare AllocationManager', async () => {
      const composed = await composeAllocation({
        now: NOW,
        extraStrategies: [new NorthernmostStrategy()],
      });

      try {
        // La registrazione ha aggiunto, non sostituito: le due politiche del modulo ci sono ancora.
        expect(composed.registeredStrategies).toEqual([...STRATEGY_NAMES, NORTHERNMOST]);

        composed.systemMode.forceActiveStrategy(NORTHERNMOST);

        const candidates = [north('RT-01', 0.01), north('RT-02', 0.09), north('RT-03', 0.05)];
        const chosen = await composed.allocation.allocate(REQUEST, candidates);

        // Nessuna delle due politiche del modulo sceglierebbe RT-02: è il più lontano, e non ha
        // un ETA. La scelta può venire solo dalla classe scritta in questo file.
        expect(chosen?.id).toBe('RT-02');

        // E le politiche di serie continuano a funzionare nella stessa composizione.
        composed.systemMode.forceActiveStrategy('NEAREST_AVAILABLE');
        expect((await composed.allocation.allocate(REQUEST, candidates))?.id).toBe('RT-01');
      } finally {
        await composed.close();
      }
    });

    it('e il contesto non nomina nessuna strategia concreta', async () => {
      // La forma falsificabile di NFR7 (DD §4.3) parla del *codice*: «senza modificare
      // AllocationManager né RideRequestManager». Il test sopra mostra che una politica nuova
      // funziona; questo mostra perché — nel manager non compare il nome di nessuna classe
      // concreta, quindi non c'è niente da modificare quando se ne aggiunge una.
      //
      // È un **complemento**, non la prova: cerca due nomi e uno `switch`, quindi passerebbe
      // anche davanti a una catena di `if (name === ...)`, che sarebbe la stessa cosa scritta a
      // mano. La prova di NFR7 è il test comportamentale qui sopra; questo dice a chi legge il
      // rosso *dove* guardare quando quello fallisce.
      const managerSource = readFileSync(
        resolve(__dirname, '..', '..', 'src', 'allocation', 'allocation.manager.ts'),
        'utf8',
      );

      // I commenti si tolgono prima di guardare: la promessa riguarda il codice, e una spiegazione
      // che *nomina* le due strategie per dire che il manager non le conosce è il caso più
      // probabile — succede in quel file, ed è giusto che continui a essere permesso.
      const code = managerSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

      expect(code).not.toMatch(/NearestAvailableStrategy|MinimumEtaStrategy/);
      // E nemmeno uno `switch` sul nome della strategia, che sarebbe la stessa cosa scritta a mano.
      expect(code).not.toMatch(/\bswitch\b/);
    });
  });

  describe('[R8][G5] L operatore legge e cambia la strategia a sistema acceso', () => {
    it('la legge, la cambia e la rilegge senza riavviare nulla', async () => {
      const before = await request(api.getHttpServer())
        .get(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect(before.body).toEqual({ activeStrategy: 'NEAREST_AVAILABLE' });

      const changed = await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ strategy: 'MINIMUM_ETA' })
        .expect(200);
      expect(changed.body).toEqual({ activeStrategy: 'MINIMUM_ETA' });

      const after = await request(api.getHttpServer())
        .get(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect(after.body).toEqual({ activeStrategy: 'MINIMUM_ETA' });
    });

    it('e il cambio è visibile a un istanza che non ha ricevuto la richiesta', async () => {
      // `harness.allocation` è un'altra composizione del modulo, collegata allo stesso database:
      // sta al cambio di strategia come la seconda istanza di M1b sta al token (NFR3). Se la
      // strategia attiva vivesse nella memoria del processo, questa istanza allocherebbe ancora
      // con quella vecchia.
      await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ strategy: 'MINIMUM_ETA' })
        .expect(200);

      expect(await harness.allocation.getActiveStrategy()).toBe('MINIMUM_ETA');
    });

    it('la scelta dell operatore porta il sistema in modo Manual, nella stessa scrittura', async () => {
      await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ strategy: 'MINIMUM_ETA' })
        .expect(200);

      const [row] = await harness.query<{ active_strategy: string; mode: string }>(
        `SELECT "active_strategy", "mode" FROM "system_mode" WHERE "id" = $1`,
        [SYSTEM_MODE_ID],
      );
      expect(row).toMatchObject({ active_strategy: 'MINIMUM_ETA', mode: 'MANUAL' });
    });

    it('rifiuta una strategia che non esiste, senza toccare quella attiva', async () => {
      await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ strategy: 'LA_PIU_ROSSA' })
        .expect(400);

      expect(await harness.allocation.getActiveStrategy()).toBe('NEAREST_AVAILABLE');
    });

    it('un passeggero non la legge e non la cambia, e senza token nessuno fa niente', async () => {
      await harness.auth.register(PASSENGER);
      const passengerToken = await login(PASSENGER.email, PASSENGER.password);

      // Le due richieste si costruiscono ed eseguono una alla volta: supertest mette in ascolto il
      // server alla prima e lo chiude quando ha finito, quindi due richieste preparate insieme
      // troverebbero la porta chiusa e fallirebbero parlando d'altro.
      await request(api.getHttpServer())
        .get(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(403);

      await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ strategy: 'MINIMUM_ETA' })
        .expect(403);

      // Senza token è 401 e non 403: «non so chi sei» è diverso da «so chi sei e non basta».
      await request(api.getHttpServer()).get(API_ROUTES.allocationStrategy).expect(401);
      await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .send({ strategy: 'MINIMUM_ETA' })
        .expect(401);

      expect(await harness.allocation.getActiveStrategy()).toBe('NEAREST_AVAILABLE');
    });
  });
});
