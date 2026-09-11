import {
  Controller,
  Get,
  Module,
  UseGuards,
  type INestApplication,
  type ModuleMetadata,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { API_ROUTES } from '@road/shared';
import request from 'supertest';

import { AuthModule } from '../../src/auth/auth.module';
import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  type AuthenticatedUser,
} from '../../src/auth/access-control.port';
import { GatewayModule } from '../../src/gateway/gateway.module';
import { ClockPort } from '../../src/platform/clock.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M1b (MILESTONES.md §M1b, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - registrazione, login e aggiornamento profilo funzionano, su HTTP vero;
 *   - un token `PASSENGER` riceve 403 sugli endpoint operatore e **viceversa**;
 *   - una password non viene mai restituita né registrata;
 *   - un token emesso da un'istanza è accettato da una **seconda** che non ha visto il login
 *     (NFR3, nella formulazione falsificabile del DD §4.3).
 *
 * **Serve Docker in esecuzione**: registrazione e login scrivono e leggono `user`, e l'unicità
 * dell'indirizzo è un vincolo del database. Su un doppio in memoria si verificherebbe il doppio.
 *
 * Le due rotte protette sono definite qui e non in `src/`, ed è voluto: M1b consegna il
 * *meccanismo* — i guard —, non gli endpoint che proteggerà. Il primo endpoint operatore vero
 * arriva con M3 (lettura e cambio della strategia di allocazione), e inventarlo adesso sarebbe una
 * funzionalità non richiesta. Ciò che il cancello deve dimostrare è che quel meccanismo, applicato
 * a una rotta, produce davvero 200/401/403 su un server vero con token veri.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

const PASSWORD = 'password-di-prova';
const OPERATOR_PASSWORD = 'password-operatrice';

const REGISTRATION = {
  email: 'giulia.rossi@example.com',
  password: PASSWORD,
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: '+39 333 1234567',
};

// -------------------------------------------------------------------------------------------
// Le rotte su cui i guard si esercitano
// -------------------------------------------------------------------------------------------

const GATE_ROUTES = {
  operatorOnly: '/gate/operator-only',
  passengerOnly: '/gate/passenger-only',
  anyAuthenticated: '/gate/any-authenticated',
} as const;

@Controller()
class ProtectedFixtureController {
  @Get(GATE_ROUTES.operatorOnly)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  operatorOnly(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  @Get(GATE_ROUTES.passengerOnly)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PASSENGER')
  passengerOnly(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }

  /**
   * Autenticata ma senza vincolo di ruolo, e **senza toccare il database**: risponde con ciò che
   * sta nel token e nient'altro. È la rotta su cui si misura NFR3.
   */
  @Get(GATE_ROUTES.anyAuthenticated)
  @UseGuards(JwtAuthGuard)
  anyAuthenticated(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}

@Module({ imports: [AuthModule], controllers: [ProtectedFixtureController] })
class ProtectedFixtureModule {}

// -------------------------------------------------------------------------------------------
// Strumenti del cancello
// -------------------------------------------------------------------------------------------

/** Ogni valore stringa dentro un oggetto, comunque annidato. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

/** Ogni nome di chiave dentro un oggetto, comunque annidato. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => [key, ...keysIn(nested)]);
  }
  return [];
}

/** Il payload di un JWT, decodificato senza verificarne la firma: qui interessa il contenuto. */
function payloadOf(accessToken: string): unknown {
  const [, payload] = accessToken.split('.');
  if (payload === undefined) throw new Error('Token senza payload.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

/**
 * Tutto ciò che il processo scrive su stdout e stderr mentre `work` è in corso.
 *
 * Serve alla metà del criterio che si dimostra solo così: «una password non viene mai loggata». Le
 * asserzioni sulle risposte dicono che non *esce dall'API*; questa dice che non finisce nemmeno
 * nei log del server, che è dove una password si perde più facilmente — un `Logger.debug` sul
 * corpo della richiesta basterebbe.
 */
async function captureOutput(work: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const streams = [process.stdout, process.stderr];
  const originals = streams.map((stream) => stream.write.bind(stream));

  for (const stream of streams) {
    stream.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof stream.write;
  }

  try {
    await work();
  } finally {
    streams.forEach((stream, index) => {
      stream.write = originals[index] as typeof stream.write;
    });
  }

  return chunks.join('');
}

let harness: ApiHarness;

/** L'istanza completa: API pubblica (`gateway`) più le rotte protette del cancello. */
let issuer: INestApplication;

/**
 * La **seconda** istanza, che non ha mai visto un login: monta solo le rotte protette, non ha
 * `gateway` e quindi non ha nemmeno `POST /auth/login`. Condivide con la prima la chiave di firma
 * e nient'altro — nessuna memoria, nessuna sessione.
 */
let verifier: INestApplication;

type NestImport = NonNullable<ModuleMetadata['imports']>[number];

async function bootApplication(imports: readonly NestImport[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [...imports] })
    .overrideProvider(ClockPort)
    .useValue(harness.clock)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

/** Registra un passeggero e restituisce il corpo della risposta. */
async function registerPassenger(
  overrides: Partial<typeof REGISTRATION> = {},
): Promise<Record<string, unknown>> {
  const response = await request(issuer.getHttpServer())
    .post(API_ROUTES.authRegister)
    .send({ ...REGISTRATION, ...overrides })
    .expect(201);
  return response.body as Record<string, unknown>;
}

/** Crea un operatore attraverso la porta — l'HTTP pubblico non lo permette — e ne fa il login. */
async function loginAsOperator(): Promise<string> {
  await harness.auth.register({
    email: 'ada.operatrice@example.com',
    password: OPERATOR_PASSWORD,
    name: 'Ada',
    surname: 'Operatrice',
    phoneNumber: null,
    role: 'OPERATOR',
  });

  const response = await request(issuer.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email: 'ada.operatrice@example.com', password: OPERATOR_PASSWORD })
    .expect(200);

  return (response.body as { accessToken: string }).accessToken;
}

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  issuer = await bootApplication([GatewayModule, ProtectedFixtureModule]);
  verifier = await bootApplication([ProtectedFixtureModule]);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await verifier?.close();
  await issuer?.close();
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
});

describe('[M1b] Cancello: AuthenticationManager', () => {
  describe('[R1][G1] Registrazione e login', () => {
    it('registrazione, login e aggiornamento profilo funzionano su HTTP', async () => {
      const registered = await registerPassenger();
      expect(registered).toMatchObject({
        tokenType: 'Bearer',
        user: { email: REGISTRATION.email, role: 'PASSENGER', createdAt: NOW.toISOString() },
      });

      const login = await request(issuer.getHttpServer())
        .post(API_ROUTES.authLogin)
        .send({ email: REGISTRATION.email, password: PASSWORD })
        .expect(200);
      const { accessToken } = login.body as { accessToken: string };

      const updated = await request(issuer.getHttpServer())
        .patch(API_ROUTES.authProfile)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Giulietta', phoneNumber: null })
        .expect(200);

      expect(updated.body).toMatchObject({
        name: 'Giulietta',
        surname: 'Rossi',
        phoneNumber: null,
      });
    });

    it('l aggiornamento delle credenziali cambia la password davvero', async () => {
      const { accessToken } = (await registerPassenger()) as unknown as { accessToken: string };

      await request(issuer.getHttpServer())
        .patch(API_ROUTES.authProfile)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: 'password-nuova-di-prova' })
        .expect(200);

      await request(issuer.getHttpServer())
        .post(API_ROUTES.authLogin)
        .send({ email: REGISTRATION.email, password: PASSWORD })
        .expect(401);

      await request(issuer.getHttpServer())
        .post(API_ROUTES.authLogin)
        .send({ email: REGISTRATION.email, password: 'password-nuova-di-prova' })
        .expect(200);
    });

    it('rifiuta credenziali sbagliate e indirizzi già presi', async () => {
      await registerPassenger();

      await request(issuer.getHttpServer())
        .post(API_ROUTES.authLogin)
        .send({ email: REGISTRATION.email, password: 'password-sbagliata' })
        .expect(401);

      await request(issuer.getHttpServer())
        .post(API_ROUTES.authRegister)
        .send(REGISTRATION)
        .expect(409);
    });

    it('normalizza l indirizzo invece di rifiutarlo per uno spazio o una maiuscola', async () => {
      // Incollare un indirizzo con uno spazio in coda è il modo più comune di sbagliarlo, e
      // maiuscole e minuscole devono indicare lo stesso account, o l'unicità dell'indirizzo non
      // significherebbe nulla. Lo schema condiviso ripulisce **prima** di validare: se le due
      // operazioni fossero nell'ordine opposto, questa registrazione risponderebbe 400.
      const registered = await registerPassenger({ email: '  Giulia.Rossi@Example.COM ' });
      expect(registered).toMatchObject({ user: { email: 'giulia.rossi@example.com' } });

      await request(issuer.getHttpServer())
        .post(API_ROUTES.authLogin)
        .send({ email: 'GIULIA.ROSSI@example.com', password: PASSWORD })
        .expect(200);
    });

    it('rifiuta un corpo non conforme al contratto, prima di toccare il database', async () => {
      await request(issuer.getHttpServer())
        .post(API_ROUTES.authRegister)
        .send({ ...REGISTRATION, password: 'corta' })
        .expect(400);

      expect(await harness.countRows('user')).toBe(0);
    });

    it('senza token il profilo non si aggiorna', async () => {
      await request(issuer.getHttpServer())
        .patch(API_ROUTES.authProfile)
        .send({ name: 'Chiunque' })
        .expect(401);

      await request(issuer.getHttpServer())
        .patch(API_ROUTES.authProfile)
        .set('Authorization', 'Bearer non-e-un-token')
        .send({ name: 'Chiunque' })
        .expect(401);
    });
  });

  describe('[R1][G1] Un token PASSENGER non apre gli endpoint operatore, e viceversa', () => {
    it('il passeggero passa sulla sua rotta e riceve 403 su quella operatore', async () => {
      const { accessToken } = (await registerPassenger()) as unknown as { accessToken: string };
      const bearer = `Bearer ${accessToken}`;

      await request(issuer.getHttpServer())
        .get(GATE_ROUTES.passengerOnly)
        .set('Authorization', bearer)
        .expect(200);

      await request(issuer.getHttpServer())
        .get(GATE_ROUTES.operatorOnly)
        .set('Authorization', bearer)
        .expect(403);
    });

    it('l operatore passa sulla sua e riceve 403 su quella passeggero', async () => {
      const bearer = `Bearer ${await loginAsOperator()}`;

      await request(issuer.getHttpServer())
        .get(GATE_ROUTES.operatorOnly)
        .set('Authorization', bearer)
        .expect(200);

      await request(issuer.getHttpServer())
        .get(GATE_ROUTES.passengerOnly)
        .set('Authorization', bearer)
        .expect(403);
    });

    it('senza token entrambe rispondono 401, non 403', async () => {
      // La distinzione conta: 401 dice «non so chi sei», 403 «so chi sei e non basta». Un guard
      // che rispondesse 403 a chi non ha token direbbe che il token c'era ed era valido.
      for (const route of [GATE_ROUTES.operatorOnly, GATE_ROUTES.passengerOnly]) {
        await request(issuer.getHttpServer()).get(route).expect(401);
      }
    });
  });

  describe('[R1][NFR3] La password non esce e non finisce nei log', () => {
    it('nessuna risposta contiene la password né il suo hash, in nessun campo', async () => {
      const bodies: unknown[] = [];

      const registered = await registerPassenger();
      bodies.push(registered);
      const { accessToken } = registered as unknown as { accessToken: string };

      const login = await request(issuer.getHttpServer())
        .post(API_ROUTES.authLogin)
        .send({ email: REGISTRATION.email, password: PASSWORD })
        .expect(200);
      bodies.push(login.body);

      const updated = await request(issuer.getHttpServer())
        .patch(API_ROUTES.authProfile)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ password: 'password-nuova-di-prova' })
        .expect(200);
      bodies.push(updated.body);

      // Anche le risposte d'errore: è lì che un corpo di richiesta viene rimandato indietro
      // «per aiutare a correggere», password compresa.
      const rejected = await request(issuer.getHttpServer())
        .post(API_ROUTES.authRegister)
        .send({ ...REGISTRATION, email: 'non-e-un-indirizzo' })
        .expect(400);
      bodies.push(rejected.body);

      for (const body of bodies) {
        expect(stringsIn(body)).not.toContain(PASSWORD);
        expect(stringsIn(body)).not.toContain('password-nuova-di-prova');
        expect(keysIn(body).map((key) => key.toLowerCase())).not.toContain('password');
        expect(keysIn(body).map((key) => key.toLowerCase())).not.toContain('passwordhash');
      }

      // E nemmeno dentro il token, che è firmato ma non cifrato: chiunque lo abbia può leggerlo.
      const payload = payloadOf(accessToken);
      expect(stringsIn(payload)).not.toContain(PASSWORD);
      expect(Object.keys(payload as object).sort()).toEqual(['email', 'exp', 'iat', 'role', 'sub']);
    });

    it('e non compare in ciò che il server scrive sui propri flussi', async () => {
      const output = await captureOutput(async () => {
        await registerPassenger();
        await request(issuer.getHttpServer())
          .post(API_ROUTES.authLogin)
          .send({ email: REGISTRATION.email, password: PASSWORD })
          .expect(200);
        // Anche il cammino d'errore: un login fallito è il momento in cui verrebbe naturale
        // registrare «tentativo con password X».
        await request(issuer.getHttpServer())
          .post(API_ROUTES.authLogin)
          .send({ email: REGISTRATION.email, password: 'password-sbagliata' })
          .expect(401);
      });

      expect(output).not.toContain(PASSWORD);
      expect(output).not.toContain('password-sbagliata');
    });
  });

  describe('[NFR3] Nessuno stato di sessione lato server', () => {
    it('una seconda istanza accetta un token che non ha mai emesso', async () => {
      const { accessToken } = (await registerPassenger()) as unknown as { accessToken: string };

      // `verifier` non monta `gateway`: il login, letteralmente, non sa servirlo.
      await request(verifier.getHttpServer()).post(API_ROUTES.authLogin).expect(404);

      const seen = await request(verifier.getHttpServer())
        .get(GATE_ROUTES.anyAuthenticated)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(seen.body).toMatchObject({ email: REGISTRATION.email, role: 'PASSENGER' });
    });

    /**
     * **Questo caso è cambiato con D78, e il cambiamento è deliberato.**
     *
     * Fino a v1.12 asseriva il contrario: cancellava la riga di `user` e pretendeva `200`, con un
     * commento che chiamava quella la linea di confine — *autenticare* non legge nulla, leggere o
     * scrivere il profilo sì. Il confine non si è spostato: **è sparito**, ed è il punto della
     * decisione. Un token il cui soggetto non esiste più non è autenticabile, perché non c'è
     * nessuno da autenticare; lasciarlo passare significava soltanto rimandare il rifiuto a un
     * punto dove non sapeva più esprimersi — una violazione di chiave esterna, cioè un `500`, alla
     * prima rotta che scriveva qualcosa di legato all'utente.
     *
     * Quel che l'asserzione vecchia proteggeva — *nessuna lettura, di nessun genere* — era più
     * severo del criterio di M1b (HARNESS.md §6: «un token emesso da un'istanza è accettato da una
     * seconda che non ha visto il login») e più severo della formulazione di NFR3 nel DD §4.3, che
     * vieta uno **store di sessione**. Il criterio è dimostrato dal caso qui sopra, che è la sua
     * traduzione verbatim e resta intatto.
     *
     * E NFR3 continua a essere verificato **anche qui**, in una forma che la versione vecchia non
     * raggiungeva: le due istanze rispondono identicamente a un token il cui account è sparito, pur
     * non avendo mai scambiato una parola. È esattamente ciò che le rende intercambiabili — la
     * fonte della risposta è il livello dati condiviso, non la memoria di chi ha emesso il token.
     */
    it('e se l account che il token dichiara non esiste più, entrambe lo rifiutano', async () => {
      const registered = await registerPassenger();
      const { accessToken } = registered as unknown as { accessToken: string };
      const { id } = (registered as unknown as { user: { id: string } }).user;

      // Il caso reale: `pnpm db:seed` svuota `user` e ricrea gli account con identificatori nuovi,
      // mentre il browser conserva il token di prima.
      await harness.query(`DELETE FROM "user" WHERE "id" = $1`, [id]);

      for (const app of [issuer, verifier]) {
        await request(app.getHttpServer())
          .get(GATE_ROUTES.anyAuthenticated)
          .set('Authorization', `Bearer ${accessToken}`)
          .expect(401);
      }

      // Anche il profilo: prima rispondeva `404`, perché il token passava il guard e l'account
      // mancante si scopriva nel gestore. Ora il rifiuto arriva prima, ed è lo stesso per tutte le
      // rotte protette — che è ciò che permette al client di avere una sola regola.
      await request(issuer.getHttpServer())
        .patch(API_ROUTES.authProfile)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ name: 'Fantasma' })
        .expect(401);
    });

    it('un token firmato con un altro segreto non è accettato da nessuna delle due', async () => {
      // La chiave condivisa è ciò che tiene insieme le repliche: senza questo test, un
      // verificatore che accettasse qualunque firma passerebbe tutti gli altri.
      const forged = [
        Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
        Buffer.from(JSON.stringify({ sub: 'chiunque', email: 'x@y.z', role: 'OPERATOR' })).toString(
          'base64url',
        ),
        'firma-inventata',
      ].join('.');

      for (const app of [issuer, verifier]) {
        await request(app.getHttpServer())
          .get(GATE_ROUTES.anyAuthenticated)
          .set('Authorization', `Bearer ${forged}`)
          .expect(401);
      }
    });
  });
});
