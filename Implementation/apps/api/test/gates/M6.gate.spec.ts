import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  API_ROUTES,
  demandAnalysisResponseSchema,
  type StrategyName,
  type TrafficLevel,
  type UserRole,
} from '@road/shared';
import request from 'supertest';

import { AllocationPort } from '../../src/allocation/allocation.port';
import { GatewayModule } from '../../src/gateway/gateway.module';
import { ModePort } from '../../src/mode/mode.port';
import { NotificationSessionPort } from '../../src/notifications/session.port';
import { PersistencePort } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { RebalancingPort } from '../../src/rebalancing/rebalancing.port';
import { recordOperator } from '../support/notifications';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M6 (MILESTONES.md §M6, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - sequenza traffico `Low→Medium→High→Medium→Low`: **alert su Medium senza cambio**, switch a
 *     `MinimumETA` su High, ritorno a `NearestAvailable` **solo** all'ultimo Low (R12, NFR9);
 *   - in modo Manual **nessuno** switch automatico avviene fino a `enableAuto()` esplicito, che
 *     rivaluta subito l'ultimo livello noto (R13, NFR10);
 *   - `analyzeDemand()` su un dataset noto — evento a San Siro compreso — restituisce le zone
 *     attese nell'ordine atteso (R10, G9);
 *   - e, perché R11 non resti una promessa, un ciclo di riposizionamento manda davvero il veicolo
 *     inattivo più vicino verso la zona più scoperta (R11, G9).
 *
 * Gira su **Postgres vero** dietro un server HTTP vero: **serve Docker in esecuzione**. Le due cose
 * non sono intercambiabili con dei doppi, e per ragioni diverse. Il database perché modo e
 * strategia vivono in un record persistito (decisione D6) e su un doppio in memoria passerebbe
 * anche una versione che li tiene in un campo privato — cioè quella che NFR3 esclude. L'HTTP perché
 * R13 parla di ciò che **l'operatore** fa «via the dashboard», e il percorso dell'operatore
 * comincia da una richiesta autenticata con un ruolo.
 *
 * Le porte di dominio si prendono dallo **stesso `moduleRef` dell'applicazione**: due composizioni
 * distinte avrebbero due `NotificationManager`, con due registri di sessioni, e l'alert finirebbe
 * in quello che nessuno sta guardando.
 */

const NOW = new Date('2026-05-04T19:30:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

/** Le tre zone del dataset. Lunedì 4 maggio 2026, 21:30 a Milano: fascia `dayOfWeek 1, hour 21`. */
const MILAN_SLOT = { dayOfWeek: 1, hourOfDay: 21 };
const DUOMO = { id: 'duomo', name: 'Duomo / Centro', lat: 45.4642, lon: 9.19 };
const SAN_SIRO = { id: 'san-siro', name: 'San Siro', lat: 45.4781, lon: 9.124 };
const NAVIGLI = { id: 'navigli', name: 'Navigli / Darsena', lat: 45.45, lon: 9.175 };

const OPERATORE = {
  email: 'ada.operatrice@example.com',
  password: 'password-di-prova',
  name: 'Ada',
  surname: 'Lovelace',
  phoneNumber: null,
  role: 'OPERATOR' as const,
};

let harness: ApiHarness;
let api: INestApplication;

// Le porte del **medesimo** contenitore dell'applicazione.
let persistence: PersistencePort;
let mode: ModePort;
let allocation: AllocationPort;
let rebalancing: RebalancingPort;
let sessions: NotificationSessionPort;

let operatorToken: string;

/** La coppia che il pannello di controllo mostra (DD §3.2). */
async function control(): Promise<{ mode: string; strategy: StrategyName }> {
  const [current, strategy] = await Promise.all([mode.getMode(), allocation.getActiveStrategy()]);
  return { mode: current, strategy };
}

/** Una sequenza di livelli osservati, nell'ordine, con la strategia attiva dopo ciascuno. */
async function strategiesObserving(...levels: readonly TrafficLevel[]): Promise<StrategyName[]> {
  const seen: StrategyName[] = [];
  for (const level of levels) {
    await mode.onTrafficLevel(level);
    seen.push(await allocation.getActiveStrategy());
  }
  return seen;
}

async function register(account: typeof OPERATORE & { role: UserRole }): Promise<string> {
  await harness.auth.register(account);
  const response = await request(api.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email: account.email, password: account.password })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}

/** Il dataset di domanda: una serata con la partita a San Siro (MILESTONES.md §M9). */
async function givenMatchNight(): Promise<void> {
  for (const zone of [DUOMO, SAN_SIRO, NAVIGLI]) await persistence.create('zone', zone);

  await persistence.create('demand_sample', { zoneId: DUOMO.id, ...MILAN_SLOT, baseDemand: 9 });
  await persistence.create('demand_sample', { zoneId: NAVIGLI.id, ...MILAN_SLOT, baseDemand: 13 });
  await persistence.create('demand_sample', { zoneId: SAN_SIRO.id, ...MILAN_SLOT, baseDemand: 3 });

  await persistence.create('demand_event', {
    zoneId: SAN_SIRO.id,
    name: 'Partita di campionato',
    multiplier: 8,
    startsAt: new Date('2026-05-04T18:00:00.000Z'),
    endsAt: new Date('2026-05-04T22:00:00.000Z'),
  });
}

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());

  const moduleRef = await Test.createTestingModule({ imports: [GatewayModule] })
    .overrideProvider(ClockPort)
    .useValue(harness.clock)
    .compile();

  api = moduleRef.createNestApplication({ logger: false });
  await api.init();

  persistence = moduleRef.get(PersistencePort);
  mode = moduleRef.get(ModePort);
  allocation = moduleRef.get(AllocationPort);
  rebalancing = moduleRef.get(RebalancingPort);
  sessions = moduleRef.get(NotificationSessionPort);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  operatorToken = await register(OPERATORE);
});

describe('[M6] Cancello: ModeController e RebalancingManager', () => {
  describe('[R12][NFR9] Stability of Auto-Switching: la sequenza completa', () => {
    it('Low→Medium→High→Medium→Low commuta esattamente due volte', async () => {
      const dashboard = recordOperator(sessions);

      const seen = await strategiesObserving('LOW', 'MEDIUM', 'HIGH', 'MEDIUM', 'LOW');

      /**
       * La proposizione di NFR9 nella formulazione del DD §4.3, verificata passo per passo.
       *
       * Il primo `MEDIUM` non commuta perché è la banda morta salendo, il secondo non commuta
       * scendendo: è l'asimmetria voluta della tabella dell'isteresi. Se uno dei due commutasse,
       * questa riga fallirebbe — che è esattamente il modo in cui il documento dice che NFR9 si
       * falsifica.
       */
      expect(seen).toEqual([
        'NEAREST_AVAILABLE', // Low: era già il default, niente da fare
        'NEAREST_AVAILABLE', // Medium: alert, nessun cambio
        'MINIMUM_ETA', // High: commuta
        'MINIMUM_ETA', // Medium: **non** rientra
        'NEAREST_AVAILABLE', // Low: solo qui torna al default
      ]);

      /**
       * «Esattamente due volte», verificato sull'elenco **completo** di ciò che l'operatore ha
       * ricevuto e non su un sottoinsieme filtrato.
       *
       * La differenza non è stilistica. Contare gli switch con un filtro — «le consegne che portano
       * un modo» — è un *proxy*: regge finché nessun altro evento porta un modo, e il giorno in cui
       * ne nasce uno l'asserzione continuerebbe a passare senza più dimostrare NFR9. Asserendo la
       * sequenza intera, qualunque evento in più o in meno rompe l'uguaglianza.
       *
       * Quattro consegne: due alert (uno per ciascun attraversamento di `MEDIUM`) e due switch.
       */
      expect(dashboard.received.map((one) => [one.trafficLevel, one.strategy, one.mode])).toEqual([
        ['MEDIUM', 'MINIMUM_ETA', null], // alert: suggerisce, non commuta
        ['HIGH', 'MINIMUM_ETA', 'AUTO'], // primo switch
        ['MEDIUM', 'MINIMUM_ETA', null], // alert di nuovo, scendendo: ancora nessun cambio
        ['LOW', 'NEAREST_AVAILABLE', 'AUTO'], // secondo e ultimo switch
      ]);
    });

    it('su Medium l operatore riceve un alert che suggerisce MinimumETA', async () => {
      const dashboard = recordOperator(sessions);

      await mode.onTrafficLevel('MEDIUM');

      // R12 chiede che su Medium accada qualcosa di osservabile proprio là dove **non** accade
      // nessuna transizione: senza l'alert, la soglia intermedia sarebbe indistinguibile dal non
      // aver letto affatto il traffico.
      const alerts = dashboard.received.filter((one) => one.mode === null);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({ trafficLevel: 'MEDIUM', strategy: 'MINIMUM_ETA' });
      expect((await control()).strategy).toBe('NEAREST_AVAILABLE');
    });
  });

  describe('[R13][NFR10] Priority of Human Intervention', () => {
    it('in Manual nessun livello di traffico cambia la strategia', async () => {
      await mode.setManual('NEAREST_AVAILABLE');

      // «No traffic level whatsoever» (DD §4.3): si prova con tutti, non solo con quello che
      // commuterebbe.
      const seen = await strategiesObserving('HIGH', 'MEDIUM', 'LOW', 'HIGH', 'HIGH');

      expect(seen).toEqual(Array<StrategyName>(5).fill('NEAREST_AVAILABLE'));
      expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });
    });

    it('il passaggio a Manual è atomico con il cambio di strategia', async () => {
      await mode.setManual('MINIMUM_ETA');

      // I due valori stanno su un record solo, quindi non esiste interleaving che li lasci in
      // disaccordo — l'altra metà con cui il DD §4.3 falsifica NFR10.
      const [record] = await persistence.find('system_mode', { limit: 1 });
      expect(record).toMatchObject({ mode: 'MANUAL', activeStrategy: 'MINIMUM_ETA' });
    });

    it('enableAuto() rivaluta subito l ultimo livello noto', async () => {
      await mode.onTrafficLevel('HIGH');
      await mode.setManual('NEAREST_AVAILABLE');
      expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });

      await mode.enableAuto();

      // Decisione D11: senza la rivalutazione il sistema resterebbe sulla scelta manuale
      // dichiarandosi automatico, e R12 sarebbe violato per un tempo che nessuno può limitare.
      expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
    });

    it('e rivaluta il traffico osservato **durante** il modo Manual', async () => {
      /**
       * La decisione D20 è la premessa della D11, e questo è il caso che le tiene insieme.
       *
       * Le letture di traffico che avvengono in modo Manual non commutano nulla, ma **lasciano
       * traccia**: se non lo facessero, `enableAuto()` rivaluterebbe il livello di prima della
       * scelta manuale — qui `LOW` — e il sistema resterebbe su `NearestAvailable` con il traffico
       * alto da un pezzo, cioè dichiarandosi automatico mentre ignora la condizione corrente.
       */
      await mode.onTrafficLevel('LOW');
      await mode.setManual('NEAREST_AVAILABLE');
      await mode.onTrafficLevel('HIGH');
      expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });

      await mode.enableAuto();

      expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
    });

    it('e su Medium tiene la strategia attiva in quell istante', async () => {
      await mode.onTrafficLevel('MEDIUM');
      await mode.setManual('MINIMUM_ETA');

      await mode.enableAuto();

      // RASD R13: «should the level be Medium […] the strategy active at that instant is kept».
      expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
    });
  });

  describe("[R13][R8] Il percorso dell'operatore, sull'HTTP pubblico", () => {
    it('scegliere una strategia porta la dashboard in Manual', async () => {
      const before = await request(api.getHttpServer())
        .get(API_ROUTES.mode)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      expect(before.body).toEqual({ mode: 'AUTO', activeStrategy: 'NEAREST_AVAILABLE' });

      await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ strategy: 'MINIMUM_ETA' })
        .expect(200);

      const after = await request(api.getHttpServer())
        .get(API_ROUTES.mode)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);
      // È il criterio del cancello di M8 visto dal lato del backend: la dashboard passa a Manual
      // perché il sistema ci è passato, non perché il client se lo ricorda.
      expect(after.body).toEqual({ mode: 'MANUAL', activeStrategy: 'MINIMUM_ETA' });
    });

    it('riabilitare Auto rivaluta e risponde con la strategia che ne risulta', async () => {
      await mode.onTrafficLevel('LOW');
      await request(api.getHttpServer())
        .put(API_ROUTES.allocationStrategy)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ strategy: 'MINIMUM_ETA' })
        .expect(200);

      const response = await request(api.getHttpServer())
        .put(API_ROUTES.mode)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ mode: 'AUTO' })
        .expect(200);

      // L'ultimo livello noto è Low, quindi il rientro riporta al default nella stessa risposta:
      // l'operatore non deve fare una seconda chiamata per sapere che cosa ha provocato.
      expect(response.body).toEqual({ mode: 'AUTO', activeStrategy: 'NEAREST_AVAILABLE' });
    });

    it('un corpo che chiede il modo Manual viene rifiutato dal contratto', async () => {
      await request(api.getHttpServer())
        .put(API_ROUTES.mode)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ mode: 'MANUAL' })
        .expect(400);

      // In Manual ci si porta scegliendo una politica, come prescrive R13: una rotta che ce lo
      // portasse senza dire quale dovrebbe inventarsene una.
      expect((await control()).mode).toBe('AUTO');
    });
  });

  describe('[R10][G9] Demand Analysis su un dataset noto', () => {
    it('la partita a San Siro porta quella zona in cima', async () => {
      await givenMatchNight();

      const { zones } = await rebalancing.analyzeDemand();

      // 3 × 8 = 24 davanti ai 13 dei Navigli e ai 9 del Duomo. Senza il livello degli eventi, San
      // Siro resterebbe ultima proprio nella sera in cui le serve tutta la flotta.
      expect(zones.map((zone) => zone.zoneId)).toEqual(['san-siro', 'navigli', 'duomo']);
      expect(zones[0]).toMatchObject({
        expectedDemand: 24,
        activeEvents: ['Partita di campionato'],
      });
    });

    it("e l'operatore la legge dall'HTTP pubblico, nello stesso ordine", async () => {
      await givenMatchNight();

      const response = await request(api.getHttpServer())
        .get(API_ROUTES.rebalancingDemand)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      // Validata contro lo **schema pubblicato**, non contro campi scelti a mano: è il contratto
      // da cui i client di M8 partono.
      expect(demandAnalysisResponseSchema.safeParse(response.body)).toMatchObject({
        success: true,
      });
      const body = response.body as { analyzedAt: string; zones: { zoneId: string }[] };
      expect(body.zones.map((zone) => zone.zoneId)).toEqual(['san-siro', 'navigli', 'duomo']);
      // L'istante viene da `ClockPort`, mai dall'orologio di sistema (CLAUDE.md Regola 3).
      expect(body.analyzedAt).toBe(NOW.toISOString());
    });

    it('la fascia oraria è quella locale di Milano, non quella UTC', async () => {
      await givenMatchNight();

      // I campioni esistono solo per le 21 locali; le 19:30 UTC di questo istante sono le 21:30 a
      // Milano. Se il manager cercasse la fascia in UTC non troverebbe nulla e ogni zona
      // risulterebbe a domanda zero — un difetto invisibile a chi provasse solo d'inverno.
      const { zones } = await rebalancing.analyzeDemand();

      expect(zones.every((zone) => zone.baseDemand > 0)).toBe(true);
    });
  });

  describe('[R11][G9] Proactive Fleet Rebalancing', () => {
    it('manda il veicolo inattivo più vicino verso la zona più scoperta', async () => {
      await givenMatchNight();
      const dashboard = recordOperator(sessions);

      // Tre veicoli fermi in centro. Il Duomo ha domanda attesa 9 e ne tiene quindi solo... nessuno
      // da cedere: si abbassa la sua base perché la sera i veicoli in centro siano in eccesso.
      await persistence.update('demand_sample', await sampleIdOf(DUOMO.id), { baseDemand: 1 });
      await persistence.update('demand_sample', await sampleIdOf(NAVIGLI.id), { baseDemand: 2 });
      for (const [id, offset] of [
        ['RT-01', 0],
        ['RT-02', 0.005],
        ['RT-03', -0.005],
      ] as const) {
        await persistence.create('robotaxi', {
          id,
          state: 'AVAILABLE',
          lat: DUOMO.lat,
          lon: DUOMO.lon + offset,
          zoneId: DUOMO.id,
        });
      }

      const plan = await rebalancing.rebalance();

      // San Siro prima dei Navigli, perché ha il deficit maggiore; `RT-03` prima di `RT-01`,
      // perché è il più a ovest e quindi il più vicino a San Siro (decisione D12).
      expect(plan.dispatched).toEqual([
        { robotaxiId: 'RT-03', targetZoneId: 'san-siro', fromZoneId: 'duomo' },
        { robotaxiId: 'RT-01', targetZoneId: 'navigli', fromZoneId: 'duomo' },
      ]);

      // I veicoli si sono mossi davvero: la transizione 8 è stata scritta in colonna.
      const fleet = await persistence.find('robotaxi', { orderBy: [{ field: 'id' }] });
      expect(fleet.map((one) => [one.id, one.state])).toEqual([
        ['RT-01', 'REBALANCING'],
        ['RT-02', 'AVAILABLE'],
        ['RT-03', 'REBALANCING'],
      ]);

      // E la dashboard lo sa, con la destinazione: «produce alert in dashboard» (MILESTONES §M6).
      const alerts = dashboard.received.filter((one) => one.zoneId !== null);
      expect(alerts.map((one) => [one.robotaxiId, one.zoneId])).toEqual([
        ['RT-03', 'san-siro'],
        ['RT-01', 'navigli'],
      ]);

      // Il giornale porta la destinazione, che non è una colonna di `robotaxi`.
      expect(await harness.countRows('rebalancing_action')).toBe(2);
    });

    it('senza squilibrio non muove nulla', async () => {
      await givenMatchNight();
      // Un veicolo solo, in una zona che ha bisogno di sé: non c'è niente da cedere.
      await persistence.create('robotaxi', {
        id: 'RT-01',
        state: 'AVAILABLE',
        lat: DUOMO.lat,
        lon: DUOMO.lon,
        zoneId: DUOMO.id,
      });

      const plan = await rebalancing.rebalance();

      // Il ramo «no rebalancing needed» della Figura 2.7: la distribuzione resta quella che è.
      expect(plan.dispatched).toEqual([]);
      expect(await harness.countRows('rebalancing_action')).toBe(0);
    });
  });
});

/** L'identificatore del campione di domanda di una zona nella fascia di questo cancello. */
async function sampleIdOf(zoneId: string): Promise<string> {
  const [sample] = await persistence.find('demand_sample', { where: { zoneId }, limit: 1 });
  if (sample === undefined) throw new Error(`Nessun campione di domanda per la zona ${zoneId}.`);
  return sample.id;
}
