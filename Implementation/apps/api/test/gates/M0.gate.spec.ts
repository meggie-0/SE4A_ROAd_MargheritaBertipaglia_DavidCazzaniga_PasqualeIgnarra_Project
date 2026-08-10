import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
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

    it('pnpm trace gira senza errori e non pretende ancora alcun requisito', () => {
      const result = spawnSync(`node "${join('tools', 'trace', 'trace.mjs')}"`, {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: true,
      });

      expect(result.stdout + result.stderr).toContain('Copertura milestone completate: 0/0');
      expect(result.status).toBe(0);
    });

    it('la CI esegue esattamente `pnpm verify` (HARNESS.md §8)', () => {
      const workflow = join(repoRoot, '..', '.github', 'workflows', 'ci.yml');
      expect(existsSync(workflow)).toBe(true);

      const content = readFileSync(workflow, 'utf8');
      expect(content).toContain('pnpm install --frozen-lockfile');
      expect(content).toContain('pnpm verify');
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
