import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  API_ROUTES,
  fleetStatusResponseSchema,
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
        const sources = sourceFilesOf(dir).map((file) => readFileSync(file, 'utf8'));
        const everything = sources.join('\n');

        expect(everything).toContain("from '@road/shared'");
        // Le rotte non si scrivono a mano: `API_ROUTES` è l'unica sede, e un indirizzo copiato
        // diverge al primo cambio del contratto senza che nulla se ne accorga.
        expect(everything).toMatch(/API_ROUTES\./);
        expect(everything).not.toMatch(/fetch\(\s*['"`]https?:\/\/[^'"`]*\/(auth|rides|fleet)/);
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

        expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).not.toMatch(/error/i);
        expect(result.status).toBe(0);
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
      [API_ROUTES.fleetStatus, 'get'],
      [API_ROUTES.mode, 'get'],
      [API_ROUTES.mode, 'put'],
      [API_ROUTES.allocationStrategy, 'get'],
      [API_ROUTES.allocationStrategy, 'put'],
    ];

    it.each(required)('dichiara %s (%s)', (path, method) => {
      expect(openapi.paths[path]?.[method]).toBeDefined();
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
