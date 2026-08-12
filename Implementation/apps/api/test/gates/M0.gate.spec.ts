import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { API_ROUTES, fetchHealth, healthResponseSchema } from '@road/shared';
import request from 'supertest';

import { AppModule } from '../../src/app.module';
import { ClockPort } from '../../src/platform/clock.port';
import { FakeClock } from '../../src/platform/fake-clock';

/**
 * Cancello di M0 (MILESTONES.md §M0, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - `pnpm verify` esiste ed è cablato con tutti i passi di HARNESS.md §1;
 *   - la CI esegue esattamente `pnpm verify` (la regola d'oro: se è verde in locale dev'essere
 *     verde in CI);
 *   - `pnpm trace` gira senza errori, con zero requisiti attesi a questo punto;
 *   - l'API risponde 200 su `GET /health`;
 *   - `apps/web` e `apps/passenger` rispondono 200 su `/` e leggono lo stato da quell'endpoint.
 *
 * Su cosa questo cancello *non* si pronuncia: che il testo appaia sullo schermo del browser. Per
 * quello serve un browser, e sta in `e2e/health.e2e.spec.ts`, che gira con `pnpm verify:e2e`.
 * La separazione è quella di HARNESS.md §1: `pnpm verify` dev'essere veloce, quindi non alza
 * browser. Qui la catena verificata è client → `fetchHealth` di @road/shared → `GET /health`
 * dell'API viva, che è la stessa identica chiamata che i due client eseguono in `App.tsx`.
 */

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const isWindows = process.platform === 'win32';

const clients = [
  { name: 'apps/web', dir: join(repoRoot, 'apps', 'web') },
  { name: 'apps/passenger', dir: join(repoRoot, 'apps', 'passenger') },
] as const;

const FAKE_NOW = '2026-05-04T09:30:00.000Z';

/** Esegue `pnpm trace`, opzionalmente su un albero di fixture invece che sulla suite vera. */
function runTrace(roots?: string): { status: number | null; output: string } {
  const result = spawnSync(`node "${join('tools', 'trace', 'trace.mjs')}"`, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: true,
    env: roots ? { ...process.env, ROAD_TRACE_ROOTS: roots } : process.env,
  });

  // I codici colore ANSI vanno tolti, o le espressioni regolari sulla tabella non agganciano.
  // La sequenza si costruisce a runtime: un byte 0x1b incollato nel sorgente è invisibile nel
  // diff, ed ESLint lo rifiuta giustamente dentro un'espressione regolare.
  const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g');
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { status: result.status, output: raw.replace(ansi, '') };
}

/** Numero di test che la tabella di `pnpm trace` attribuisce a un requisito. */
function testsFor(output: string, id: string): number {
  const row = new RegExp(`^${id}\\s+.*?\\s(\\d+)(\\s|$)`, 'm').exec(output);
  if (!row) throw new Error(`Il requisito ${id} non compare nella tabella di trace.`);
  return Number.parseInt(row[1] as string, 10);
}

/**
 * Riserva `count` porte libere e distinte.
 *
 * Le sonde restano tutte aperte finché non sono state assegnate tutte le porte: chiuderne una
 * prima di aprire la successiva farebbe restituire al sistema operativo la stessa porta due volte,
 * e i due dev server si contenderebbero lo stesso numero.
 */
async function freePorts(count: number): Promise<number[]> {
  const probes = [];
  const ports: number[] = [];

  for (let i = 0; i < count; i += 1) {
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const address = probe.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    if (port === 0) throw new Error('Nessuna porta libera disponibile.');
    probes.push(probe);
    ports.push(port);
  }

  for (const probe of probes) {
    await new Promise<void>((done) => probe.close(() => done()));
  }
  return ports;
}

// Avviare Nest e due dev server Vite a freddo non sta nei 5 secondi di default di Jest.
const HOOK_TIMEOUT_MS = 120_000;

const POLL_INTERVAL_MS = 250;
const POLL_ATTEMPTS = 320; // ~80 secondi, il tempo che un dev server Vite può prendersi a freddo

/**
 * Attende che un server risponda. Conta i tentativi invece di guardare l'orologio: anche qui la
 * regola vale, e un numero di tentativi è più leggibile di una scadenza.
 */
async function waitForHttp(url: string, processLog: readonly string[] = []): Promise<void> {
  let lastError = 'nessun tentativo';

  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(POLL_INTERVAL_MS);
  }

  throw new Error(
    `${url} non ha risposto dopo ${POLL_ATTEMPTS} tentativi (ultimo errore: ${lastError}).\n` +
      `Output del processo:\n${processLog.join('') || '(nessuno)'}`,
  );
}

/**
 * Ferma un dev server e tutto ciò che ha generato.
 *
 * Il figlio nasce sotto una shell, quindi `child.kill()` ucciderebbe solo la shell e lascerebbe
 * vivo il processo Vite: Jest, che ne tiene ancora aperte le pipe, non uscirebbe mai. È successo
 * davvero — i 27 test del cancello passavano in 5 secondi e il job di CI restava appeso finché
 * non scadeva. Su Windows si usa `taskkill /T`, su Unix il figlio è capogruppo (`detached`) e si
 * uccide l'intero gruppo con il pid negativo.
 */
function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;

  if (isWindows) {
    spawnSync(`taskkill /pid ${child.pid} /T /F`, { shell: true });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }

  child.stdout?.destroy();
  child.stderr?.destroy();
}

describe('[M0] Cancello: walking skeleton', () => {
  describe('Harness di verifica', () => {
    const rootPackage = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    it.each([
      'verify',
      'typecheck',
      'lint',
      'arch',
      'contract',
      'test:unit',
      'test:int',
      'gate',
      'trace',
      'verify:e2e',
      'dev',
      'db:migrate',
      'db:seed',
    ])('lo script "%s" esiste nel package.json radice', (script) => {
      expect(rootPackage.scripts[script]).toBeDefined();
    });

    it('pnpm verify esegue tutti i passi di HARNESS.md §1', () => {
      const verify = readFileSync(join(repoRoot, 'tools', 'verify', 'verify.mjs'), 'utf8');
      const steps = [...verify.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);

      // Che lo script esista non basta: dev'esserci dentro ogni controllo che HARNESS.md §1
      // elenca, gate compreso (§6: i cancelli già passati non tornano mai rossi).
      expect(steps).toEqual([
        // Il primo passo si chiamava `shared` finché il monorepo aveva un solo pacchetto di
        // libreria; da M7 ne compila due, perché il simulatore di flotta è il secondo.
        'packages',
        'typecheck',
        'lint',
        'arch',
        'contract',
        'unit',
        'gate',
        'trace',
        'integration',
      ]);
    });

    it('pnpm trace gira senza errori e non lascia requisiti scoperti', () => {
      const result = runTrace();

      expect(result.status).toBe(0);
      // Si asserisce l'invariante — coperti uguale attesi — e non il letterale "0/0" che vale
      // solo finché M0 è l'unica milestone chiusa. Un cancello che scade è un cancello che
      // diventerà rosso accusando M0 per il lavoro di M1.
      const summary = /Copertura milestone completate: (\d+)\/(\d+)/.exec(result.output);
      expect(summary).not.toBeNull();
      expect(summary?.[1]).toBe(summary?.[2]);
    });

    it('pnpm trace attribuisce i test al requisito giusto', () => {
      // Il tracciatore è ciò che rende verificabile la Regola 4: se conta male, dichiara scoperto
      // un requisito che ha i test (e porta a inseguire un difetto che non c'è) o coperto uno che
      // non li ha. Entrambi gli errori sono già successi, ed è per questo che c'è questo test.
      const roots = mkdtempSync(join(tmpdir(), 'road-trace-'));
      try {
        writeFileSync(
          join(roots, 'fratelli.spec.ts'),
          [
            "describe('[R5] primo', () => {",
            "  it('uno', () => {});",
            "  describe('annidato', () => { it('due', () => {}); });",
            '});',
            "describe('[R8] secondo', () => { it('tre', () => {}); });",
          ].join('\n'),
          'utf8',
        );
        writeFileSync(
          join(roots, 'each.spec.ts'),
          [
            "describe('[R10] solo it.each', () => {",
            "  it.each([1, 2])('caso %s', () => {});",
            '});',
          ].join('\n'),
          'utf8',
        );

        const { output } = runTrace(roots);

        // R5 possiede due test (il proprio e quello del describe annidato); R8 uno solo. Se il
        // describe di R5 non venisse tolto dalla pila, i suoi tag finirebbero anche su R8.
        expect(testsFor(output, 'R5')).toBe(2);
        expect(testsFor(output, 'R8')).toBe(1);
        // I test scritti con `it.each` sono test: contarli zero renderebbe "scoperto" un
        // requisito coperto.
        expect(testsFor(output, 'R10')).toBeGreaterThan(0);
      } finally {
        rmSync(roots, { recursive: true, force: true });
      }
    });

    it('la CI esegue esattamente `pnpm verify` (HARNESS.md §8)', () => {
      const workflow = join(repoRoot, '..', '.github', 'workflows', 'ci.yml');
      expect(existsSync(workflow)).toBe(true);

      const content = readFileSync(workflow, 'utf8');
      const verifyJob = content.slice(content.indexOf('jobs:'), content.indexOf('  e2e:'));
      const commands = [...verifyJob.matchAll(/^ {6}- run: (.+)$/gm)].map((match) => match[1]);

      // "Esattamente" è la parola che conta (HARNESS.md §1, regola d'oro): non `pnpm verify`
      // *più* una lista parallela di comandi, che è proprio la divergenza fra locale e CI contro
      // cui la regola è scritta.
      expect(commands).toEqual(['pnpm install --frozen-lockfile', 'pnpm verify']);
    });

    it('docker-compose alza Postgres 16 con btree_gist disponibile', () => {
      const compose = readFileSync(join(repoRoot, 'docker-compose.yml'), 'utf8');
      expect(compose).toMatch(/postgres:16/);

      const init = readFileSync(
        join(repoRoot, 'docker', 'postgres', 'init', '001-extensions.sql'),
        'utf8',
      );
      expect(init).toMatch(/CREATE EXTENSION IF NOT EXISTS btree_gist/i);
    });

    it('il README documenta i passi di installazione richiesti dalle linee guida §5.3', () => {
      const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
      for (const step of [
        'pnpm install',
        'docker compose up -d',
        'pnpm db:migrate',
        'pnpm db:seed',
        'pnpm dev',
      ]) {
        expect(readme).toContain(step);
      }
    });
  });

  describe('API', () => {
    let app: INestApplication;
    let apiUrl: string;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        // Il tempo dev'essere quello che decide il test, non quello della macchina: è la prova
        // che l'endpoint passa da ClockPort e non da `new Date()` (CLAUDE.md Regola 3).
        .overrideProvider(ClockPort)
        .useValue(new FakeClock(FAKE_NOW))
        .compile();

      app = moduleRef.createNestApplication({ logger: false });
      await app.init();
      const [apiPort] = await freePorts(1);
      await app.listen(apiPort as number);
      apiUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
    }, HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await app?.close();
    });

    it('risponde 200 su GET /health', async () => {
      const response = await request(app.getHttpServer()).get(API_ROUTES.health);

      expect(response.status).toBe(200);
    });

    it('risponde con un payload conforme al contratto condiviso', async () => {
      const response = await request(app.getHttpServer()).get(API_ROUTES.health);

      const parsed = healthResponseSchema.safeParse(response.body);
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.status).toBe('ok');
    });

    it("legge l'orario da ClockPort e non dall'orologio di sistema", async () => {
      const response = await request(app.getHttpServer()).get(API_ROUTES.health);

      expect(response.body.time).toBe(FAKE_NOW);
    });

    it('è raggiungibile da fuori con la stessa funzione che usano i client', async () => {
      const health = await fetchHealth(apiUrl);

      expect(health.status).toBe('ok');
      expect(health.service).toBe('road-api');
    });
  });

  describe('Client', () => {
    const servers: ChildProcess[] = [];
    const urls = new Map<string, string>();
    const logs = new Map<string, string[]>();

    beforeAll(async () => {
      const ports = await freePorts(clients.length);

      clients.forEach((client, index) => {
        const port = ports[index] as number;
        // `--host 127.0.0.1` non è pignoleria: senza, Vite ascolta su "localhost", che su Windows
        // si risolve prima su ::1, e il test bussa a una porta IPv4 dove non c'è nessuno.
        const child = spawn(`pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`, {
          cwd: client.dir,
          shell: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          // Su Unix rende il figlio capogruppo, così `killTree` può spegnere anche i nipoti.
          detached: !isWindows,
        });

        // L'output del dev server si conserva: se non parte, il messaggio utile è il suo, non
        // "non ha risposto" — un cancello rosso deve dire perché.
        const log: string[] = [];
        child.stdout?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
        child.stderr?.on('data', (chunk: Buffer) => log.push(chunk.toString()));
        logs.set(client.name, log);

        servers.push(child);
        urls.set(client.name, `http://127.0.0.1:${port}`);
      });

      for (const client of clients) {
        await waitForHttp(`${urls.get(client.name)}/`, logs.get(client.name) ?? []);
      }
    }, HOOK_TIMEOUT_MS);

    afterAll(() => {
      for (const server of servers) killTree(server);
    });

    it.each(clients.map((client) => client.name))('%s risponde 200 su /', async (name) => {
      const response = await fetch(`${urls.get(name)}/`);

      expect(response.status).toBe(200);
    });

    it.each(clients.map((client) => client.name))("%s serve la pagina dell'app", async (name) => {
      const html = await (await fetch(`${urls.get(name)}/`)).text();

      expect(html).toContain('<div id="root">');
      expect(html).toContain('/src/main.tsx');
    });

    it.each(clients.map((client) => [client.name, client.dir]))(
      "%s legge lo stato dall'API tramite @road/shared, senza importare nulla da apps/api",
      (_name, dir) => {
        const source = readFileSync(join(dir, 'src', 'App.tsx'), 'utf8');

        expect(source).toMatch(/fetchHealth\s*\(/);
        expect(source).toContain("from '@road/shared'");
        expect(source).not.toMatch(/apps\/api/);
      },
    );
  });
});
