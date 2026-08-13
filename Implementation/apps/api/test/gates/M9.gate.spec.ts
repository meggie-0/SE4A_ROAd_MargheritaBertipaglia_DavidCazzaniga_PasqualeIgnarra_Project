import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { API_ROUTES, type RideRequestResponse, type UserRole } from '@road/shared';
import request from 'supertest';

import { GatewayModule } from '../../src/gateway/gateway.module';
import { PersistencePort } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M9 (MILESTONES.md §M9, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - **i quattro scenari del RASD end-to-end**: esistono, sono eseguibili, nessuno è disattivato,
 *     e coprono le quattro storie del §2.1 — le si esegue con `pnpm test:int`, che è dentro
 *     `pnpm verify`;
 *   - **il test di concorrenza**: due richieste simultanee per l'ultimo robotaxi disponibile,
 *     esattamente una assegnata (NFR1, NFR4). Questo gira **qui**, perché è il criterio stesso e
 *     non una premessa;
 *   - **`pnpm trace` senza requisiti scoperti**;
 *   - **tutti i cancelli precedenti**: che esistano, perché quelli sì che girano da soli dentro
 *     `pnpm verify` e un cancello di M9 che li rieseguisse raddoppierebbe la verifica;
 *   - **`verify:e2e`**: gli scenari con il browser esistono, non sono disattivati e il runner li
 *     raccoglie. Che *passino* lo dice `pnpm verify:e2e`, e nient'altro (HARNESS.md §1: la
 *     verifica veloce non alza browser);
 *   - **il README eseguito da zero**: i comandi che promette esistono, e quelli che toccano il
 *     database si eseguono davvero contro un Postgres appena creato — migrazioni, seed e dataset di
 *     dimostrazione, nell'ordine in cui il README li mette.
 *
 * **Serve Docker in esecuzione.**
 *
 * Su cosa questo cancello *non* si pronuncia, e vale la pena scriverlo invece di lasciarlo
 * intendere: non dice che la dimostrazione sia bella, né che un essere umano capisca la dashboard.
 * Dice che la catena che la regge — le storie del RASD, il comportamento sotto concorrenza, i
 * comandi del README, i dati della serata — è quella dichiarata.
 */

const repoRoot = resolve(__dirname, '..', '..', '..', '..');
const HOOK_TIMEOUT_MS = 240_000;
/** Costruire l'API e seminare un database vuoto costa: il README non promette che sia istantaneo. */
const README_TIMEOUT_MS = 600_000;

const NOW = new Date('2026-05-04T09:30:00.000Z');

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };

const ZONE = { id: 'duomo', name: 'Duomo / Centro', ...DUOMO };

const ANNA = {
  email: 'anna@example.com',
  password: 'password-di-prova',
  name: 'Anna',
  surname: 'Bianchi',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};

const BEA = { ...ANNA, email: 'bea@example.com', name: 'Bea' };

let harness: ApiHarness;
let api: INestApplication;
let persistence: PersistencePort;

async function signIn(account: {
  email: string;
  password: string;
  role: UserRole;
}): Promise<string> {
  await harness.auth.register({ ...ANNA, ...account });
  const response = await request(api.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email: account.email, password: account.password })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}

/** Il file di uno scenario end-to-end, letto come testo. */
const specOf = (...path: string[]): string => readFileSync(join(repoRoot, ...path), 'utf8');

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
  await persistence.create('zone', ZONE);
});

describe('[M9] Cancello: test di sistema e demo', () => {
  describe("[NFR1][NFR4][G10] Due richieste simultanee per l'ultimo robotaxi", () => {
    /**
     * Il criterio di M9, alla lettera: «due richieste simultanee per l'ultimo robotaxi disponibile,
     * esattamente una assegnata».
     *
     * **Perché non basta il cancello di M1.** Quello dimostra che il *database* non lascia
     * sovrapporre due riserve, sul suo vincolo di esclusione. Questo dimostra che il *sistema* si
     * comporta bene quando quel rifiuto arriva: che la richiesta perdente non resti a metà, che il
     * veicolo non finisca assegnato due volte, e che chi ha perso riceva una risposta sensata invece
     * di un 500. Sono due proprietà diverse — la seconda è quella che vede un passeggero.
     *
     * Le due richieste partono da **due passeggeri diversi**: una corsa in corso non impedisce a chi
     * la sta facendo di chiederne un'altra, ma è dalla contesa fra estranei che nasce il caso vero.
     */
    it('esattamente una viene accettata, e il veicolo è assegnato una volta sola', async () => {
      const anna = await signIn(ANNA);
      const bea = await signIn(BEA);

      // **Uno solo.** Con due veicoli non ci sarebbe contesa e il test passerebbe sempre.
      await persistence.create('robotaxi', {
        id: 'RT-ULTIMO',
        state: 'AVAILABLE',
        lat: DUOMO.lat,
        lon: DUOMO.lon,
        zoneId: ZONE.id,
      });

      const chiedi = (token: string): Promise<{ body: RideRequestResponse }> =>
        request(api.getHttpServer())
          .post(API_ROUTES.ridesImmediate)
          .set('Authorization', `Bearer ${token}`)
          .send({ pickup: DUOMO, destination: CENTRALE })
          .expect(201) as unknown as Promise<{ body: RideRequestResponse }>;

      // `Promise.all` e non due `await` in fila: in sequenza la seconda troverebbe il veicolo già
      // assegnato e il test verificherebbe una lettura, non una corsa fra due scritture.
      const [prima, seconda] = await Promise.all([chiedi(anna), chiedi(bea)]);
      const esiti = [prima.body, seconda.body];

      const accettate = esiti.filter((esito) => esito.status === 'ACCEPTED');
      const rifiutate = esiti.filter((esito) => esito.status === 'REJECTED');

      // Esattamente una. Non «almeno una»: due assegnazioni dello stesso veicolo sono il difetto
      // che NFR1 esiste per escludere, e sarebbero invisibili a un'asserzione più debole.
      expect(accettate).toHaveLength(1);
      expect(rifiutate).toHaveLength(1);
      expect(accettate[0]?.assignedRobotaxiId).toBe('RT-ULTIMO');

      // Un rifiuto **non è un errore**: la richiesta è persistita e racconta che la flotta era
      // sottodimensionata (RASD Figura 3.1). Perderla vorrebbe dire perdere quel dato.
      expect(rifiutate[0]?.assignedRobotaxiId).toBeNull();
      expect(await harness.countRows('ride_request')).toBe(2);

      // Il veicolo è assegnato, una volta sola, e con una riserva sola.
      const [veicolo] = await persistence.find('robotaxi', {
        where: { id: 'RT-ULTIMO' },
        limit: 1,
      });
      expect(veicolo?.state).toBe('ASSIGNED');
      expect(await harness.countRows('robotaxi_reservation')).toBe(1);
    });

    it('con due veicoli passano entrambe, e ciascuna prende il proprio', async () => {
      /*
       * Il complemento del caso sopra, e non un test di comodo: senza, un sistema che rifiutasse
       * *sempre* la seconda richiesta simultanea — per un blocco troppo largo, per una transazione
       * che serializza tutto — passerebbe il criterio di M9 sembrando corretto. Il criterio dice
       * «esattamente una» perché il veicolo era uno, non perché la concorrenza vada punita.
       */
      const anna = await signIn(ANNA);
      const bea = await signIn(BEA);

      for (const id of ['RT-01', 'RT-02']) {
        await persistence.create('robotaxi', {
          id,
          state: 'AVAILABLE',
          lat: DUOMO.lat,
          lon: DUOMO.lon,
          zoneId: ZONE.id,
        });
      }

      const chiedi = (token: string): Promise<{ body: RideRequestResponse }> =>
        request(api.getHttpServer())
          .post(API_ROUTES.ridesImmediate)
          .set('Authorization', `Bearer ${token}`)
          .send({ pickup: DUOMO, destination: CENTRALE })
          .expect(201) as unknown as Promise<{ body: RideRequestResponse }>;

      const [prima, seconda] = await Promise.all([chiedi(anna), chiedi(bea)]);

      expect(prima.body.status).toBe('ACCEPTED');
      expect(seconda.body.status).toBe('ACCEPTED');
      // Veicoli **diversi**: è la metà del requisito che il caso a un veicolo non può mostrare.
      expect(prima.body.assignedRobotaxiId).not.toBe(seconda.body.assignedRobotaxiId);
      expect(await harness.countRows('robotaxi_reservation')).toBe(2);
    });
  });

  describe('I quattro scenari del RASD', () => {
    const scenari = specOf(
      'apps',
      'api',
      'test',
      'integration',
      'scenarios',
      'rasd-scenarios.spec.ts',
    );

    /**
     * Le quattro storie del RASD §2.1, riconosciute dal titolo.
     *
     * Il cancello guarda i **titoli** e non conta i file: uno scenario è finito quando la storia che
     * racconta è quella del documento, e un test che si limitasse a controllare l'esistenza di un
     * file passerebbe anche con quel file vuoto.
     */
    const STORIE = [
      'Scenario 1 — Corsa immediata e ciclo di vita del veicolo',
      'Scenario 2 — Prenotazione anticipata',
      'Scenario 3 — Gestione automatica e manuale della strategia',
      'Scenario 4 — Riposizionamento dinamico della flotta',
    ];

    it.each(STORIE)('%s è coperto da un test di sistema', (storia) => {
      expect(scenari).toContain(storia);
    });

    it('nessuno degli scenari è disattivato', () => {
      // È la scorciatoia più facile da prendere quando uno scenario diventa fastidioso, ed è quella
      // che CLAUDE.md vieta in tante parole. Le asserzioni qui sopra leggono il *testo* del file, e
      // il testo di un test disattivato è identico a quello di un test che gira.
      expect(scenari).not.toMatch(/\b(it|test|describe)\.(skip|todo|failing|only)\b/);
    });

    it('gli scenari girano dentro pnpm verify', () => {
      // `jest.config.mjs` raccoglie `apps/api/test/integration/**`, che è il passo 9 di
      // HARNESS.md §1: se un giorno il percorso cambiasse, gli scenari smetterebbero di girare
      // senza che nulla diventi rosso.
      const jestConfig = readFileSync(join(repoRoot, 'jest.config.mjs'), 'utf8');
      expect(jestConfig).toContain('apps/api/test/integration/**/*.spec.ts');
      expect(existsSync(join(repoRoot, 'apps', 'api', 'test', 'integration', 'scenarios'))).toBe(
        true,
      );
    });
  });

  describe('Tutti i cancelli precedenti', () => {
    const PRECEDENTI = ['M0', 'M1', 'M1b', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'];

    it.each(PRECEDENTI)('il cancello di %s esiste', (milestone) => {
      /*
       * Esistenza, non riesecuzione. I cancelli girano tutti dentro `pnpm verify` (passo 7), quindi
       * chiamarli da qui li eseguirebbe due volte e raddoppierebbe il tempo della verifica per non
       * sapere niente di nuovo. Ciò che questo test aggiunge è l'altra metà: che nessuno di essi
       * sia stato **cancellato** per far passare qualcosa — un cancello che sparisce non fa fallire
       * niente, e HARNESS.md §5 ci lega anche il tracciamento, perché «milestone completata»
       * significa «cancello scritto».
       */
      expect(
        existsSync(join(repoRoot, 'apps', 'api', 'test', 'gates', `${milestone}.gate.spec.ts`)),
      ).toBe(true);
    });
  });

  describe('Una sola cadenza per le posizioni', () => {
    /**
     * I quattro punti che devono battere insieme (decisione D71).
     *
     * L'invariante non è verificabile eseguendo qualcosa: i due scheduler sono dichiarazioni che
     * `ScheduleModule` trasforma in esecuzioni, e i due client girano in un browser. Ciò che si può
     * verificare è che nessuno dei quattro abbia il proprio numero — ed è precisamente il modo in
     * cui l'invariante si perderebbe: qualcuno scrive `500` o `5_000` a mano, tutto continua a
     * funzionare, e alla prima modifica della costante il mondo avanza più in fretta di quanto lo si
     * osservi. Un controllo sul testo è debole, ma è più forte del nulla che c'era.
     */
    const cadenzati = [
      ['apps', 'api', 'src', 'external', 'simulator.schedule.ts'],
      ['apps', 'api', 'src', 'rides', 'fleet-telemetry.schedule.ts'],
      ['apps', 'web', 'src', 'App.tsx'],
      ['apps', 'passenger', 'src', 'App.tsx'],
    ];

    it.each(cadenzati.map((path) => [path.join('/'), path]))(
      '%s prende la cadenza da @road/shared, non da un numero suo',
      (_name, path) => {
        const source = specOf(...(path as string[]));

        expect(source).toContain('FLEET_POSITION_REFRESH_MS');
        // Le due forme in cui il numero rientrerebbe: un intervallo dichiarato con una costante
        // numerica, o un `refetchInterval` scritto a mano.
        expect(source).not.toMatch(/@Interval\(\s*\d/);
        expect(source).not.toMatch(/refetchInterval:\s*\d/);
      },
    );
  });

  describe('Tracciabilità', () => {
    it('pnpm trace non lascia requisiti scoperti', () => {
      const result = spawnSync(`node "${join('tools', 'trace', 'trace.mjs')}"`, {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: true,
      });

      const ansi = new RegExp(`${String.fromCharCode(27)}\\[\\d+m`, 'g');
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(ansi, '');

      // Il numero, non solo il codice di uscita: `34/34` è il criterio di M9 scritto in cifre, e
      // un tracciatore che uscisse zero avendo trovato meno voci passerebbe senza dirlo.
      expect(output).toContain('Copertura milestone completate: 34/34');
      expect(result.status).toBe(0);

      // E M9 è fra le milestone con cancello: da questo file in poi il tracciamento pretende anche
      // i suoi requisiti, che è ciò che rende il criterio «trace completo» non vacuo.
      expect(output).toMatch(/Milestone con cancello scritto:.*\bM9\b/);
    });
  });

  describe('Gli scenari con il browser', () => {
    const e2e = [
      'health.e2e.spec.ts',
      'passenger-ride.e2e.spec.ts',
      'operator-dashboard.e2e.spec.ts',
    ];

    it.each(e2e)('%s esiste e non ha scenari disattivati', (file) => {
      const spec = specOf('e2e', file);
      expect(spec).not.toMatch(/\b(test|describe)\.(skip|fixme|only)\b/);
    });

    it('pnpm verify:e2e li raccoglie e prepara il database', () => {
      const config = readFileSync(join(repoRoot, 'playwright.config.ts'), 'utf8');
      expect(config).toMatch(/testDir:\s*'\.\/e2e'/);
      expect(config).toMatch(/testMatch:\s*'\*\*\/\*\.e2e\.spec\.ts'/);

      const runner = readFileSync(join(repoRoot, 'tools', 'e2e', 'run.mjs'), 'utf8');
      expect(runner).toMatch(/db\/migrate\.mjs/);
      expect(runner).toMatch(/db\/seed\.mjs/);
    });
  });

  describe('Il README eseguito da zero', () => {
    const readme = readFileSync(join(repoRoot, 'README.md'), 'utf8');
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    /** Ogni `pnpm <script>` che il README nomina. */
    const promessi = [...readme.matchAll(/`pnpm ([a-z][\w:]*)/g)]
      .map((match) => match[1] as string)
      .filter((name) => name !== 'install' && name !== 'exec')
      .filter((name, index, all) => all.indexOf(name) === index);

    it('ogni comando che il README promette esiste', () => {
      expect(promessi.length).toBeGreaterThan(0);
      // Il difetto che questo previene è banale e frequentissimo: un comando rinominato nel
      // `package.json` e non nel README manda chi segue le istruzioni contro un errore al primo
      // passo, cioè proprio dove la documentazione conta di più (linee guida del corso §5.3).
      expect(promessi.filter((name) => packageJson.scripts[name] === undefined)).toEqual([]);
    });

    it('le credenziali che il README pubblica sono quelle che il seed usa', () => {
      // Le password di sviluppo stanno in `.env.example`, e il README le ripete perché chi apre la
      // dashboard le trovi senza aprire un file di configurazione. Due copie divergono: qui si
      // verifica che non l'abbiano ancora fatto.
      const envExample = readFileSync(join(repoRoot, '.env.example'), 'utf8');
      for (const variabile of [
        'SEED_OPERATOR_EMAIL',
        'SEED_OPERATOR_PASSWORD',
        'SEED_PASSENGER_EMAIL',
        'SEED_PASSENGER_PASSWORD',
      ]) {
        const valore = new RegExp(`^${variabile}=(.+)$`, 'm').exec(envExample)?.[1]?.trim();
        expect({ variabile, valore }).toEqual({ variabile, valore: expect.any(String) });
        expect({ variabile, nelReadme: readme.includes(valore as string) }).toEqual({
          variabile,
          nelReadme: true,
        });
      }
    });

    it(
      'migrazioni, seed e dataset di dimostrazione girano su un database appena creato',
      async () => {
        /*
         * I comandi **veri**, nell'ordine del README, contro un Postgres vuoto.
         *
         * È la traduzione eseguibile di «README verificato eseguendo le istruzioni da zero su una
         * macchina pulita» (MILESTONES.md §M9). Non sostituisce quella verifica a mano — un
         * container non è una macchina pulita, e `pnpm install` qui non si esegue — ma copre la
         * parte che si rompe da sola col tempo: che i tre comandi funzionino ancora, in
         * quell'ordine, su uno schema che non c'era.
         */
        await harness.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

        const esegui = (script: string): { status: number | null; output: string } => {
          const result = spawnSync(`node "${join('tools', 'db', script)}"`, {
            cwd: repoRoot,
            encoding: 'utf8',
            shell: true,
            env: { ...process.env, DATABASE_URL: harness.databaseUrl },
          });
          return {
            status: result.status,
            output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
          };
        };

        const migrazioni = esegui('migrate.mjs');
        expect({ passo: 'migrate', status: migrazioni.status }).toEqual({
          passo: 'migrate',
          status: 0,
        });

        const seed = esegui('seed.mjs');
        expect({ passo: 'seed', status: seed.status, output: seed.output }).toMatchObject({
          passo: 'seed',
          status: 0,
        });
        expect(seed.output).toContain('Zone: 16');

        const demo = esegui('demo.mjs');
        expect({ passo: 'demo', status: demo.status, output: demo.output }).toMatchObject({
          passo: 'demo',
          status: 0,
        });

        /*
         * L'esito che rende la serata una serata: **un evento solo, allo stadio, attivo adesso**.
         *
         * Il moltiplicatore non si asserisce, perché il comando lo calcola sui dati della fascia
         * oraria in cui gira — è quello il punto: una dimostrazione deve funzionare a mezzogiorno
         * come alle undici di sera. Ciò che deve valere sempre è che lo stadio superi la zona più
         * affollata, e questa è la forma verificabile di quella promessa.
         */
        const eventi = await harness.query<{
          zone_id: string;
          starts_at: Date;
          ends_at: Date;
          multiplier: number;
        }>('SELECT "zone_id", "starts_at", "ends_at", "multiplier" FROM "demand_event"');

        expect(eventi).toHaveLength(1);
        expect(eventi[0]?.zone_id).toBe('san-siro');

        /*
         * L'istante di riferimento viene dal **database**, non da `Date.now()`.
         *
         * Non è un cavillo per aggirare la Regola 3: il comando di dimostrazione gira in un altro
         * processo, con l'orologio vero, e per dire «l'evento è attivo adesso» serve un'ora che non
         * sia quella finta dell'harness. Postgres è il testimone esterno che entrambi i processi
         * condividono — e leggerla di lì, invece che dall'orologio di questo processo, è anche la
         * lettura più giusta: è la stessa sorgente su cui il confronto avverrà davvero.
         */
        const [orologio] = await harness.query<{ adesso: Date }>('SELECT now() AS adesso');
        const adesso = (orologio?.adesso as Date).getTime();

        expect(eventi[0]?.starts_at.getTime()).toBeLessThanOrEqual(adesso);
        expect(eventi[0]?.ends_at.getTime()).toBeGreaterThan(adesso);

        // E la flotta è tutta disponibile, con **nessun veicolo allo stadio**: senza una zona
        // davvero scoperta non ci sarebbe deficit, e il riposizionamento non avrebbe nulla da fare.
        const flotta = await harness.query<{ state: string; zone_id: string }>(
          'SELECT "state", "zone_id" FROM "robotaxi"',
        );
        expect(flotta).toHaveLength(20);
        expect(flotta.every((veicolo) => veicolo.state === 'AVAILABLE')).toBe(true);
        expect(flotta.filter((veicolo) => veicolo.zone_id === 'san-siro')).toEqual([]);

        /*
         * **E su quel dataset il riposizionamento fa davvero partire qualcuno.**
         *
         * È l'asserzione che rende la dimostrazione una dimostrazione, e tutte quelle qui sopra
         * sarebbero vere anche nel mondo in cui `rebalance()` non manda mai nessuno — che è
         * esattamente il mondo in cui questo comando è nato: con i profili di domanda del seed, fra
         * le sette del mattino e le undici di sera **nessuna zona ha veicoli cedibili**, quindi un
         * evento allo stadio spostava la classifica senza spostare un veicolo. Il comando adesso
         * abbassa la domanda della fascia corrente, e questo test è ciò che impedisce a quella
         * correzione di sparire senza che nulla diventi rosso.
         *
         * L'orologio finto si porta sull'ora del database: il comando ha scritto la finestra
         * dell'evento sull'ora vera, e con l'harness fermo al 4 maggio l'evento non risulterebbe
         * attivo — il ciclo non troverebbe nessun picco e il test fallirebbe dicendo il falso.
         */
        harness.clock.setNow(new Date(adesso));
        const piano = await harness.rebalancing.rebalance();

        expect(piano.zones[0]?.zoneId).toBe('san-siro');
        expect(piano.dispatched.map((invio) => invio.targetZoneId)).toEqual(['san-siro']);
        expect(piano.dispatched[0]?.fromZoneId).not.toBe('san-siro');

        /*
         * Lo schema torna com'era, **esplicitamente**.
         *
         * Questo caso è l'unico del file che distrugge e ricostruisce il database, e finora
         * sopravviveva solo perché è l'ultimo dichiarato: `beforeEach` avrebbe rimesso a posto le
         * tabelle, ma per una coincidenza dell'ordine di esecuzione, che è precisamente ciò che
         * HARNESS.md §2 vieta. Ripulire qui rende l'indipendenza una scelta invece di una fortuna.
         */
        await harness.reset();
        harness.clock.setNow(NOW);
      },
      README_TIMEOUT_MS,
    );
  });
});
