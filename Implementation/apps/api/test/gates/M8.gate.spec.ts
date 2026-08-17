import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  API_ROUTES,
  assignedVehicleResponseSchema,
  fleetStatusResponseSchema,
  maintenanceCompleteRoute,
  maintenanceCompletedResponseSchema,
  maintenanceStartRoute,
  maintenanceStartedResponseSchema,
  rideVehicleRoute,
  modeResponseSchema,
  ROBOTAXI_STATES,
  type UserRole,
} from '@road/shared';
import request from 'supertest';

import { GatewayModule } from '../../src/gateway/gateway.module';
import { PersistencePort } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M8 (MILESTONES.md §M8, HARNESS.md §6).
 *
 * Criterio di completamento: «Playwright — un passeggero richiede una corsa e vede lo stato
 * aggiornarsi fino a `in_ride`; un operatore cambia strategia e vede la dashboard passare a
 * Manual; screenshot salvati per entrambi i flussi».
 *
 * **Quel criterio ha bisogno di un browser, e `pnpm verify` non ne alza uno** (HARNESS.md §1: la
 * verifica dev'essere veloce). La divisione è la stessa che M0 ha già fissato per la sua metà
 * visiva: gli scenari con il browser vivono in `e2e/*.e2e.spec.ts` e girano con `pnpm verify:e2e`;
 * qui si verifica tutto ciò che li rende possibili e che, se si rompesse, li farebbe fallire senza
 * dire perché.
 *
 * Cinque cose, quindi:
 *
 *  1. i due client parlano **solo** l'HTTP pubblico e i tipi condivisi — nessun import da
 *     `apps/api`, in nessun file, non solo in `App.tsx` (CLAUDE.md Regola 1);
 *  2. i due client **si costruiscono davvero**: `tsc` non vede gli import di CSS, gli asset e
 *     l'interoperabilità fra formati di modulo, che è esattamente la classe di difetti che in M0
 *     falliva solo dentro un browser;
 *  3. il contratto pubblicato dichiara **ogni** rotta che i due client chiamano, con il verbo
 *     giusto: è ciò che rende il frontend sostituibile (HARNESS.md §4);
 *  4. `GET /fleet/status`, la rotta che M8 aggiunge, funziona su HTTP vero e rispetta lo schema
 *     condiviso, con i vincoli di ruolo di M1b;
 *  5. `GET /mode` porta modo **e** strategia in una risposta sola, che è la proprietà su cui
 *     poggia la metà di NFR6 che riguarda l'operatore;
 *  6. gli scenari end-to-end del criterio esistono e asseriscono le due cose che devono asserire.
 *
 * **Serve Docker in esecuzione**: la panoramica di flotta legge la tabella `robotaxi`.
 */

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const NOW = new Date('2026-05-04T09:30:00.000Z');
const HOOK_TIMEOUT_MS = 240_000;

const clients = [
  { name: 'apps/web', dir: join(repoRoot, 'apps', 'web') },
  { name: 'apps/passenger', dir: join(repoRoot, 'apps', 'passenger') },
] as const;

const OPERATRICE = {
  email: 'ada.operatrice@example.com',
  password: 'password-di-prova',
  name: 'Ada',
  surname: 'Lovelace',
  phoneNumber: null,
  role: 'OPERATOR' as const,
};

const PASSEGGERA = {
  email: 'giulia.passeggera@example.com',
  password: 'password-di-prova',
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};

/** Le zone dei tre veicoli: `robotaxi.zone_id` è una chiave esterna, e vuole le righe già lì. */
const ZONES = [
  { id: 'duomo', name: 'Duomo / Centro', lat: 45.4642, lon: 9.19 },
  { id: 'san-siro', name: 'San Siro', lat: 45.4781, lon: 9.124 },
  { id: 'navigli', name: 'Navigli / Darsena', lat: 45.45, lon: 9.175 },
];

/** Tre veicoli, uno per stato interessante: la fotografia deve saperli contare tutti. */
const ROBOTAXIS = [
  { id: 'rt-01', state: 'AVAILABLE' as const, lat: 45.4642, lon: 9.19, zoneId: 'duomo' },
  { id: 'rt-02', state: 'IN_RIDE' as const, lat: 45.4781, lon: 9.124, zoneId: 'san-siro' },
  { id: 'rt-03', state: 'MAINTENANCE' as const, lat: 45.45, lon: 9.175, zoneId: 'navigli' },
];

let harness: ApiHarness;
let api: INestApplication;
let persistence: PersistencePort;
let operatorToken: string;
let passengerToken: string;

async function signIn(account: {
  email: string;
  password: string;
  role: UserRole;
}): Promise<string> {
  const response = await request(api.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email: account.email, password: account.password })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}

/** Ogni nome di chiave dentro un oggetto, comunque annidato. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...keysIn(nested)]);
  }
  return [];
}

/** Ogni file sorgente di un client, ricorsivamente. */
function sourceFilesOf(dir: string): string[] {
  const root = join(dir, 'src');
  const found: string[] = [];

  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|tsx)$/.test(entry)) found.push(full);
    }
  };

  walk(root);
  return found;
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
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);

  await harness.auth.register(OPERATRICE);
  await harness.auth.register(PASSEGGERA);
  operatorToken = await signIn(OPERATRICE);
  passengerToken = await signIn(PASSEGGERA);

  for (const zone of ZONES) await persistence.create('zone', zone);
  for (const robotaxi of ROBOTAXIS) await persistence.create('robotaxi', robotaxi);
});

describe('[M8] Cancello: i due client', () => {
  describe('[NFR8] I client parlano solo il contratto pubblico', () => {
    it.each(clients.map((client) => [client.name, client.dir]))(
      '%s non importa nulla da apps/api, in nessun file',
      (_name, dir) => {
        const offenders = sourceFilesOf(dir).filter((file) => {
          const source = readFileSync(file, 'utf8');
          return /from\s+['"][^'"]*apps\/api/.test(source) || /@road\/api/.test(source);
        });

        // Il test di M0 guardava il solo `App.tsx`, che in M8 non è più tutta l'applicazione: un
        // import proibito dentro un componente sarebbe passato inosservato.
        expect(offenders).toEqual([]);
      },
    );

    it.each(clients.map((client) => [client.name, client.dir]))(
      '%s prende dal pacchetto condiviso le rotte e gli schemi',
      (_name, dir) => {
        /*
         * **File per file**, non su tutto il sorgente concatenato.
         *
         * La prima versione univa i venti file in una stringa sola e poi chiedeva che *quella*
         * contenesse `@road/shared` e `API_ROUTES.`: bastava un file su venti a soddisfare
         * l'asserzione per l'intera applicazione, e diciannove che scrivevano gli indirizzi a mano
         * sarebbero passati. Qui si guarda ogni file che parla con la rete e gli si chiede di
         * prendere la rotta da dove va presa.
         */
        const talksToTheNetwork = sourceFilesOf(dir)
          .map((file) => ({ file, source: readFileSync(file, 'utf8') }))
          .filter(({ source }) => /apiRequest\(|fetch\(|io\(/.test(source));

        expect(talksToTheNetwork.length).toBeGreaterThan(0);

        for (const { file, source } of talksToTheNetwork) {
          // Le rotte non si scrivono a mano: `API_ROUTES` (o le costanti del canale push) sono
          // l'unica sede, e un indirizzo copiato diverge al primo cambio del contratto senza che
          // nulla se ne accorga.
          expect({ file, shared: source.includes("from '@road/shared'") }).toEqual({
            file,
            shared: true,
          });
          expect({
            file,
            hardcoded: /['"`]https?:\/\/[^'"`]*\/(auth|rides|fleet|mode)/.test(source),
          }).toEqual({ file, hardcoded: false });
        }
      },
    );
  });

  describe('I client si costruiscono', () => {
    /**
     * `tsc` non basta, e M0 lo ha già dimostrato: la prima versione passava ogni controllo con
     * `packages/shared` compilato solo in CommonJS e falliva **solo** dentro il browser. Un build
     * vero attraversa gli import di CSS, gli asset di Leaflet e l'interoperabilità fra formati di
     * modulo, che è la parte che nessun typecheck vede.
     */
    it.each(clients.map((client) => [client.name, client.dir]))(
      '%s produce un bundle',
      (_name, dir) => {
        const result = spawnSync('pnpm exec vite build --logLevel warn', {
          cwd: dir,
          shell: true,
          encoding: 'utf8',
        });

        // Il codice di uscita e l'artefatto, non una ricerca di «error» nell'output: Vite esce
        // diverso da zero quando fallisce, e cercare quella parola avrebbe fatto fallire il
        // cancello al primo file di sorgente che si chiamasse `…Error….`
        expect(result.status).toBe(0);
        expect(existsSync(join(dir, 'dist', 'index.html'))).toBe(true);
      },
      HOOK_TIMEOUT_MS,
    );
  });

  describe('[NFR8] Il contratto pubblicato basta a riscrivere un client', () => {
    const openapi = JSON.parse(
      readFileSync(join(repoRoot, 'contracts', 'openapi.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, unknown>> };

    /** Le operazioni che i due client di M8 usano, e che quindi il contratto deve dichiarare. */
    const required: readonly [string, string][] = [
      [API_ROUTES.authRegister, 'post'],
      [API_ROUTES.authLogin, 'post'],
      [API_ROUTES.ridesImmediate, 'post'],
      [API_ROUTES.ridesAdvance, 'post'],
      [API_ROUTES.rideCancel, 'post'],
      [API_ROUTES.rideVehicle, 'get'],
      [API_ROUTES.authProfile, 'patch'],
      [API_ROUTES.fleetStatus, 'get'],
      [API_ROUTES.mode, 'get'],
      [API_ROUTES.mode, 'put'],
      [API_ROUTES.allocationStrategy, 'get'],
      [API_ROUTES.allocationStrategy, 'put'],
      [API_ROUTES.maintenanceStart, 'post'],
      [API_ROUTES.maintenanceComplete, 'post'],
    ];

    /**
     * Dal segnaposto di Nest a quello dell'OpenAPI: `:rideRequestId` diventa `{rideRequestId}`.
     *
     * `API_ROUTES` porta la forma che il decoratore di Nest si aspetta, il contratto pubblicato
     * quella dello standard. Convertire qui, in un punto solo, evita di scrivere gli indirizzi due
     * volte — che è precisamente ciò che questo blocco di test esiste per impedire.
     */
    const openApiPath = (route: string): string => route.replace(/:(\w+)/g, '{$1}');

    it.each(required)('dichiara %s (%s)', (path, method) => {
      expect(openapi.paths[openApiPath(path)]?.[method]).toBeDefined();
    });
  });

  describe('[R7][G8] GET /fleet/status: la flotta che la dashboard disegna', () => {
    it("risponde all'operatore con posizione e stato di ogni veicolo", async () => {
      const response = await request(api.getHttpServer())
        .get(API_ROUTES.fleetStatus)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      // La risposta si valida con lo **schema condiviso**, che è ciò che il client userà: se il
      // backend le facesse divergere, un client scritto sul contratto si romperebbe qui e non
      // tre schermate più in là.
      const parsed = fleetStatusResponseSchema.safeParse(response.body);
      expect(parsed.success).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.total).toBe(ROBOTAXIS.length);
      expect(parsed.data.robotaxis.map((vehicle) => vehicle.id)).toEqual([
        'rt-01',
        'rt-02',
        'rt-03',
      ]);
      expect(parsed.data.robotaxis[0]?.position).toEqual({ lat: 45.4642, lon: 9.19 });
      // L'istante viene da `ClockPort` e non dall'orologio di sistema (CLAUDE.md Regola 3).
      expect(parsed.data.observedAt).toBe(NOW.toISOString());
    });

    it('conta tutti e sette gli stati, zeri compresi', async () => {
      const response = await request(api.getHttpServer())
        .get(API_ROUTES.fleetStatus)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      const counts = (response.body as { countsByState: Record<string, number> }).countsByState;

      // La status bar mostra una colonna per stato: se il backend ne omettesse quelli a zero, la
      // colonna «in manutenzione» sparirebbe proprio quando la flotta sta bene.
      expect(Object.keys(counts).sort()).toEqual([...ROBOTAXI_STATES].sort());
      expect(counts.AVAILABLE).toBe(1);
      expect(counts.IN_RIDE).toBe(1);
      expect(counts.MAINTENANCE).toBe(1);
      expect(counts.ARRIVING).toBe(0);
    });

    it('è riservata agli operatori', async () => {
      await request(api.getHttpServer())
        .get(API_ROUTES.fleetStatus)
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(403);

      await request(api.getHttpServer()).get(API_ROUTES.fleetStatus).expect(401);
    });
  });

  describe('[R9][NFR5] Gestione della manutenzione tramite HTTP', () => {
    it('avvia e completa la manutenzione di un robotaxi disponibile', async () => {
      const startedResponse = await request(api.getHttpServer())
        .post(maintenanceStartRoute('rt-01'))
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ reason: 'Controllo periodico dei sensori' })
        .expect(201);

      const started = maintenanceStartedResponseSchema.safeParse(startedResponse.body);

      expect(started.success).toBe(true);
      if (!started.success) return;

      expect(started.data.robotaxi.id).toBe('rt-01');
      expect(started.data.robotaxi.state).toBe('MAINTENANCE');
      expect(started.data.record.robotaxiId).toBe('rt-01');
      expect(started.data.record.reason).toBe('Controllo periodico dei sensori');
      expect(started.data.record.status).toBe('ONGOING');
      expect(started.data.record.endedAt).toBeNull();

      const fleetDuringMaintenance = await request(api.getHttpServer())
        .get(API_ROUTES.fleetStatus)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      const vehicleDuringMaintenance = (
        fleetDuringMaintenance.body as {
          robotaxis: Array<{ id: string; state: string }>;
        }
      ).robotaxis.find((vehicle) => vehicle.id === 'rt-01');

      expect(vehicleDuringMaintenance?.state).toBe('MAINTENANCE');

      const completedResponse = await request(api.getHttpServer())
        .post(maintenanceCompleteRoute('rt-01'))
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      const completed = maintenanceCompletedResponseSchema.safeParse(completedResponse.body);

      expect(completed.success).toBe(true);
      if (!completed.success) return;

      expect(completed.data.robotaxi.id).toBe('rt-01');
      expect(completed.data.robotaxi.state).toBe('AVAILABLE');
      expect(completed.data.record?.status).toBe('COMPLETED');
      expect(completed.data.record?.endedAt).toBe(NOW.toISOString());
    });

    it('rifiuta le transizioni incompatibili con lo stato corrente', async () => {
      // rt-02 è IN_RIDE: non può essere messo in manutenzione.
      await request(api.getHttpServer())
        .post(maintenanceStartRoute('rt-02'))
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ reason: 'Controllo sensori' })
        .expect(409);

      // rt-01 è AVAILABLE: non può completare una manutenzione inesistente.
      await request(api.getHttpServer())
        .post(maintenanceCompleteRoute('rt-01'))
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(409);
    });

    it('valida il motivo della manutenzione', async () => {
      await request(api.getHttpServer())
        .post(maintenanceStartRoute('rt-01'))
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ reason: '   ' })
        .expect(400);
    });

    it('è riservata agli operatori autenticati', async () => {
      await request(api.getHttpServer())
        .post(maintenanceStartRoute('rt-01'))
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ reason: 'Controllo sensori' })
        .expect(403);

      await request(api.getHttpServer())
        .post(maintenanceStartRoute('rt-01'))
        .send({ reason: 'Controllo sensori' })
        .expect(401);
    });
  });

  describe('[R3][R6] GET /rides/:id/vehicle: dove si trova il robotaxi della propria corsa', () => {
    /**
     * La rotta che l'app passeggero interroga per disegnare il veicolo che si avvicina
     * (decisione D69).
     *
     * Il test che conta è il terzo: la risposta **non deve portare lo stato**. È una proprietà
     * negativa, e le proprietà negative si perdono con la prima aggiunta fatta in buona fede — un
     * campo `state` messo lì «perché era comodo» renderebbe NFR2 non più verificabile, perché
     * nessun test potrebbe più distinguere una transizione arrivata push da una scoperta
     * interrogando.
     */
    async function requestRide(): Promise<string> {
      const response = await request(api.getHttpServer())
        .post(API_ROUTES.ridesImmediate)
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ pickup: { lat: 45.4642, lon: 9.19 }, destination: { lat: 45.4781, lon: 9.227 } })
        .expect(201);
      return (response.body as { id: string }).id;
    }

    it('risponde con la posizione del veicolo assegnato', async () => {
      const rideRequestId = await requestRide();

      const response = await request(api.getHttpServer())
        .get(rideVehicleRoute(rideRequestId))
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      const parsed = assignedVehicleResponseSchema.safeParse(response.body);
      expect(parsed.success).toBe(true);
      // L'unico veicolo allocabile del fixture è `rt-01`: gli altri due sono in corsa e in
      // manutenzione, quindi la scelta non è ambigua.
      expect(parsed.success && parsed.data.vehicle?.robotaxiId).toBe('rt-01');
      expect(parsed.success && parsed.data.vehicle?.position).toEqual({ lat: 45.4642, lon: 9.19 });
    });

    it('non porta lo stato del veicolo né quello della corsa', async () => {
      const rideRequestId = await requestRide();

      const response = await request(api.getHttpServer())
        .get(rideVehicleRoute(rideRequestId))
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);

      // Si guardano **tutte** le chiavi, comunque annidate: un campo di stato aggiunto in fondo a
      // un oggetto interno sfuggirebbe a un controllo sul solo livello esterno.
      const keys = keysIn(response.body).map((key) => key.toLowerCase());
      expect(keys).not.toContain('state');
      expect(keys).not.toContain('status');
      expect(keys).not.toContain('ridestatus');
      expect(keys).not.toContain('robotaxistate');
    });

    it('la corsa di un altro passeggero non esiste', async () => {
      const rideRequestId = await requestRide();

      await harness.auth.register({ ...PASSEGGERA, email: 'altra.passeggera@example.com' });
      const altro = await signIn({ ...PASSEGGERA, email: 'altra.passeggera@example.com' });

      // 404 e non 403: distinguere «non è tua» da «non esiste» permetterebbe di scoprire quali
      // corse esistono provando identificatori. È la stessa scelta di `cancel()`.
      await request(api.getHttpServer())
        .get(rideVehicleRoute(rideRequestId))
        .set('Authorization', `Bearer ${altro}`)
        .expect(404);

      await request(api.getHttpServer())
        .get(rideVehicleRoute(rideRequestId))
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(403);
    });
  });

  describe('[NFR6] Modo e strategia al primo render, senza navigare', () => {
    it('una sola richiesta porta entrambi i valori', async () => {
      const response = await request(api.getHttpServer())
        .get(API_ROUTES.mode)
        .set('Authorization', `Bearer ${operatorToken}`)
        .expect(200);

      // È la proprietà del contratto su cui poggia la metà di NFR6 che riguarda l'operatore: con
      // due rotte separate la dashboard mostrerebbe un valore prima dell'altro, e ci sarebbe un
      // istante in cui uno dei due indicatori non c'è.
      const parsed = modeResponseSchema.safeParse(response.body);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.mode).toBe('AUTO');
      expect(parsed.success && parsed.data.activeStrategy).toBe('NEAREST_AVAILABLE');
    });
  });

  /**
   * **Che cosa questa sezione dimostra, e che cosa no.**
   *
   * Il criterio di M8 è uno scenario guidato da un browser, e `pnpm verify` non ne alza uno
   * (HARNESS.md §1). Quello che si può controllare da qui è che gli scenari *esistano, dicano la
   * cosa giusta e siano eseguibili*: che nominino `in_ride` e il modo Manual, che salvino gli
   * screenshot, che nessuno li abbia disattivati e che il runner li raccolga. Che poi **passino** lo
   * dice `pnpm verify:e2e`, e nient'altro.
   *
   * È una distinzione che vale la pena tenere esplicita invece di lasciarla intendere: il verde di
   * `pnpm gate M8` significa «le premesse ci sono tutte», non «il criterio è soddisfatto». Le
   * premesse però sono verificate sul serio — la rotta di flotta su HTTP vero con i ruoli, i due
   * bundle, il contratto — perché sono ciò che, rompendosi, farebbe fallire gli scenari senza dire
   * perché.
   */
  describe('Gli scenari end-to-end del criterio di completamento', () => {
    const e2eDir = join(repoRoot, 'e2e');
    const specOf = (file: string): string => readFileSync(join(e2eDir, file), 'utf8');

    it('il passeggero segue la corsa fino a in_ride, e salva uno screenshot', () => {
      const spec = specOf('passenger-ride.e2e.spec.ts');

      // Il criterio nomina `in_ride` e gli screenshot: un cancello che si limitasse a controllare
      // che il file esista passerebbe anche con un test vuoto.
      expect(spec).toMatch(/data-phase['"],\s*['"]in_ride['"]/);
      expect(spec).toMatch(/screenshot\(\{\s*path:/);
      expect(spec).toMatch(/request-ride/);
    });

    it('l operatore cambia strategia e vede il modo passare a Manual, e salva uno screenshot', () => {
      const spec = specOf('operator-dashboard.e2e.spec.ts');

      expect(spec).toMatch(/select-strategy-/);
      expect(spec).toMatch(/data-mode['"],\s*['"]MANUAL['"]/);
      expect(spec).toMatch(/screenshot\(\{\s*path:/);
    });

    it.each(['passenger-ride.e2e.spec.ts', 'operator-dashboard.e2e.spec.ts'])(
      '%s non ha scenari disattivati',
      (file) => {
        const spec = specOf(file);

        /*
         * Senza questo controllo il cancello sarebbe soddisfatto da uno scenario `test.skip`: le
         * asserzioni qui sopra leggono il **testo** del file, e il testo di un test disattivato è
         * identico a quello di un test che gira. È la scorciatoia più facile da prendere quando uno
         * scenario diventa fastidioso, ed è quella che CLAUDE.md vieta in tante parole.
         *
         * `.only` è l'altra faccia: farebbe passare la suite eseguendo un test solo.
         */
        expect(spec).not.toMatch(/\b(test|describe)\.(skip|fixme|only)\b/);
        expect(spec).not.toMatch(/\btest\.setTimeout\b/);
      },
    );

    it('gli scenari sono raccolti da pnpm verify:e2e', () => {
      const config = readFileSync(join(repoRoot, 'playwright.config.ts'), 'utf8');
      expect(config).toMatch(/testDir:\s*'\.\/e2e'/);
      expect(config).toMatch(/testMatch:\s*'\*\*\/\*\.e2e\.spec\.ts'/);

      // Gli scenari di M8 hanno bisogno del seed: senza account operatore e senza veicoli in
      // flotta fallirebbero entrambi, e il messaggio parlerebbe d'altro.
      const runner = readFileSync(join(repoRoot, 'tools', 'e2e', 'run.mjs'), 'utf8');
      expect(runner).toMatch(/db\/migrate\.mjs/);
      expect(runner).toMatch(/db\/seed\.mjs/);
    });

    /**
     * Il tracciatore non deve perdere un `describe` che segue una stringa contenente `/*`.
     *
     * Il caso è quello vero incontrato scrivendo questa milestone: il glob di Playwright con cui lo
     * scenario del passeggero conta le richieste all'API contiene `/` seguito da due asterischi, e
     * `stripComments()` lo trattava come l'apertura di un commento di blocco — cancellando tutto
     * fino alla fine del blocco di documentazione successivo, `describe` compreso. NFR6 risultava
     * **scoperto** pur avendo il suo test.
     *
     * Sta nel cancello di M8 e non in quello di M0 perché è M8 a inciamparci: è il primo file di
     * test del progetto che scrive quella sequenza dentro una stringa. Il difetto è quello che
     * HARNESS.md §5 chiama per nome — «un tracciatore che conta male è peggio di nessun
     * tracciatore» — e senza questo test tornerebbe silenziosamente.
     */
    it('pnpm trace non perde i tag dopo una stringa che contiene una sequenza di commento', () => {
      const roots = mkdtempSync(join(tmpdir(), 'road-trace-m8-'));
      try {
        writeFileSync(
          join(roots, 'glob.spec.ts'),
          [
            "describe('[R3] prima della stringa', () => {",
            // La sequenza che apriva il finto commento — una barra seguita da due asterischi —
            // si compone a runtime: scritta per esteso qui dentro, **questo** file la conterrebbe
            // dentro una stringa, e il tracciatore rotto perderebbe i `describe` del cancello
            // stesso. Il test riprodurrebbe il difetto invece di verificarlo.
            `  it('usa un glob', () => { const pattern = 'https://x${'/'}${'*'.repeat(2)}'; });`,
            '});',
            '/** Un blocco di documentazione, che chiudeva il finto commento. */',
            "describe('[NFR6] dopo la stringa', () => {",
            "  it('esiste', () => {});",
            '});',
          ].join('\n'),
          'utf8',
        );

        const result = spawnSync(`node "${join('tools', 'trace', 'trace.mjs')}"`, {
          cwd: repoRoot,
          encoding: 'utf8',
          shell: true,
          env: { ...process.env, ROAD_TRACE_ROOTS: roots },
        });

        const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g');
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(ansi, '');

        // Il requisito che segue la stringa dev'essere contato: prima della correzione era zero.
        const row = /^NFR6\s+.*?\s(\d+)(\s|$)/m.exec(output);
        expect(row).not.toBeNull();
        expect(Number.parseInt(row?.[1] ?? '0', 10)).toBe(1);
      } finally {
        rmSync(roots, { recursive: true, force: true });
      }
    });
  });
});
