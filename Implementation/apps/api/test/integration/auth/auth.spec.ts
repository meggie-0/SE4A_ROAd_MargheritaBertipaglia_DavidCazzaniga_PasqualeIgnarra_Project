import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  UnknownUserError,
  type AuthPort,
  type RegisterInput,
} from '../../../src/auth/auth.port';
import type { PersistencePort } from '../../../src/persistence/persistence.port';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * L'`AuthenticationManager` su un database vero (M1b; RASD R1, R2, G1).
 *
 * Perché di integrazione e non unitario: le due proprietà che contano davvero qui sono proprietà
 * *del database*. L'unicità dell'indirizzo la garantisce un vincolo, non un controllo applicativo,
 * e su un doppio in memoria si potrebbe scrivere un `Map` che sembra rispettarla mentre il vincolo
 * vero non esiste; che l'hash finisca in colonna e la password in chiaro no si vede solo leggendo
 * la colonna.
 *
 * Tutto passa da `AuthPort`. La connessione grezza dell'harness serve solo ad asserire ciò che il
 * database *contiene*, che è un'altra cosa dal chiedere al modulo cosa ha fatto.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

const PASSWORD = 'password-di-prova';

const PASSENGER: RegisterInput = {
  email: 'giulia.rossi@example.com',
  password: PASSWORD,
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: '+39 333 1234567',
  role: 'PASSENGER',
};

let harness: ApiHarness;
let auth: AuthPort;
let persistence: PersistencePort;

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  auth = harness.auth;
  persistence = harness.persistence;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
});

describe('[R1][G1] Registration and Login', () => {
  describe('register', () => {
    it('crea l account, lo autentica subito e ne data la nascita con ClockPort', async () => {
      const { user, token } = await auth.register(PASSENGER);

      expect(user).toMatchObject({
        email: PASSENGER.email,
        name: 'Giulia',
        surname: 'Rossi',
        phoneNumber: '+39 333 1234567',
        role: 'PASSENGER',
        // L'istante viene dall'orologio del modulo, non da quello di sistema (Regola 3): con
        // `new Date()` questa asserzione non sarebbe scrivibile.
        createdAt: NOW,
      });
      expect(token.accessToken.split('.')).toHaveLength(3);
      expect(token.expiresInSeconds).toBeGreaterThan(0);
    });

    it('normalizza l indirizzo, così il login non dipende da come è stato digitato', async () => {
      await auth.register({ ...PASSENGER, email: '  Giulia.Rossi@Example.COM ' });

      const { user } = await auth.authenticate({ email: PASSENGER.email, password: PASSWORD });

      expect(user.email).toBe('giulia.rossi@example.com');
    });

    it('rifiuta un indirizzo già registrato', async () => {
      await auth.register(PASSENGER);

      await expect(auth.register({ ...PASSENGER, name: 'Altra' })).rejects.toBeInstanceOf(
        EmailAlreadyRegisteredError,
      );
      expect(await harness.countRows('user')).toBe(1);
    });

    it('lo rifiuta anche se differisce solo per maiuscole', async () => {
      await auth.register(PASSENGER);

      await expect(
        auth.register({ ...PASSENGER, email: 'GIULIA.ROSSI@EXAMPLE.COM' }),
      ).rejects.toBeInstanceOf(EmailAlreadyRegisteredError);
    });

    it('crea anche gli operatori: il ruolo è un parametro della porta', async () => {
      // `POST /auth/register` crea sempre un `PASSENGER`, perché il RASD non prevede
      // l'auto-iscrizione di un operatore. Ma un account operatore deve poter esistere, o metà di
      // R1 — «allow both Passengers and Fleet Operators to securely authenticate» — sarebbe
      // irrealizzabile. Lo crea il seed, da qui.
      const { user } = await auth.register({ ...PASSENGER, role: 'OPERATOR', phoneNumber: null });

      expect(user.role).toBe('OPERATOR');
      expect(user.phoneNumber).toBeNull();
    });
  });

  describe('authenticate', () => {
    it('accetta le credenziali giuste ed emette un token nuovo', async () => {
      const registered = await auth.register(PASSENGER);

      const logged = await auth.authenticate({ email: PASSENGER.email, password: PASSWORD });

      expect(logged.user).toEqual(registered.user);
      expect(logged.token.accessToken.split('.')).toHaveLength(3);
    });

    it('rifiuta la password sbagliata', async () => {
      await auth.register(PASSENGER);

      await expect(
        auth.authenticate({ email: PASSENGER.email, password: 'password-sbagliata' }),
      ).rejects.toBeInstanceOf(InvalidCredentialsError);
    });

    it('rifiuta un indirizzo sconosciuto **con lo stesso errore**', async () => {
      await auth.register(PASSENGER);

      const unknown = auth.authenticate({ email: 'nessuno@example.com', password: PASSWORD });

      // Stesso tipo e stesso messaggio del caso precedente: due errori distinti direbbero a
      // chiunque quali indirizzi sono registrati.
      await expect(unknown).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(unknown).rejects.toThrow(new InvalidCredentialsError().message);
    });
  });

  describe('La password nel database', () => {
    it('in colonna c è un hash bcrypt, non la password', async () => {
      const { user } = await auth.register(PASSENGER);

      const [row] = await harness.query<{ password_hash: string }>(
        `SELECT "password_hash" FROM "user" WHERE "id" = $1`,
        [user.id],
      );

      expect(row?.password_hash).not.toBe(PASSWORD);
      expect(row?.password_hash).toMatch(/^\$2[aby]\$\d{2}\$/);
    });

    it('e non esce dalla porta in nessuna forma', async () => {
      const { user } = await auth.register(PASSENGER);

      // `AccountProfile` elenca i campi ammessi invece di togliere quelli vietati: il giorno in
      // cui `user` prendesse una colonna sensibile in più, non uscirebbe di qui per distrazione.
      expect(Object.keys(user).sort()).toEqual([
        'createdAt',
        'email',
        'id',
        'name',
        'phoneNumber',
        'role',
        'surname',
      ]);
    });
  });
});

describe('[R2][G1] Profile Management', () => {
  it('aggiorna le informazioni personali e lascia il resto com era', async () => {
    const { user } = await auth.register(PASSENGER);

    const updated = await auth.updateProfile(user.id, { name: 'Giulietta' });

    expect(updated).toMatchObject({
      id: user.id,
      name: 'Giulietta',
      surname: 'Rossi',
      email: PASSENGER.email,
      phoneNumber: '+39 333 1234567',
    });
  });

  it('distingue «non indicato» da «indicato nullo» sul telefono', async () => {
    const { user } = await auth.register(PASSENGER);

    await auth.updateProfile(user.id, { name: 'Giulietta' });
    expect((await auth.updateProfile(user.id, { surname: 'Bianchi' })).phoneNumber).toBe(
      '+39 333 1234567',
    );

    expect((await auth.updateProfile(user.id, { phoneNumber: null })).phoneNumber).toBeNull();
  });

  it('cambia le credenziali: la password vecchia non vale più, la nuova sì', async () => {
    const { user } = await auth.register(PASSENGER);

    await auth.updateProfile(user.id, { password: 'password-nuova-di-prova' });

    await expect(
      auth.authenticate({ email: PASSENGER.email, password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
    await expect(
      auth.authenticate({ email: PASSENGER.email, password: 'password-nuova-di-prova' }),
    ).resolves.toMatchObject({ user: { id: user.id } });
  });

  it('cambia l indirizzo, e il login segue', async () => {
    const { user } = await auth.register(PASSENGER);

    await auth.updateProfile(user.id, { email: 'Giulia.Bianchi@Example.com' });

    await expect(
      auth.authenticate({ email: 'giulia.bianchi@example.com', password: PASSWORD }),
    ).resolves.toMatchObject({ user: { id: user.id } });
    await expect(
      auth.authenticate({ email: PASSENGER.email, password: PASSWORD }),
    ).rejects.toBeInstanceOf(InvalidCredentialsError);
  });

  it('rifiuta un indirizzo già di un altro account', async () => {
    const { user } = await auth.register(PASSENGER);
    await auth.register({ ...PASSENGER, email: 'ada@example.com', role: 'OPERATOR' });

    await expect(auth.updateProfile(user.id, { email: 'ada@example.com' })).rejects.toBeInstanceOf(
      EmailAlreadyRegisteredError,
    );

    // E non lascia nulla a metà: l'indirizzo resta quello di prima.
    await expect(
      auth.authenticate({ email: PASSENGER.email, password: PASSWORD }),
    ).resolves.toMatchObject({ user: { id: user.id } });
  });

  it('rifiuta un utente inesistente', async () => {
    // È il caso di un token ancora valido il cui account è stato rimosso: senza stato di sessione
    // lato server (NFR3) nessuno può accorgersene prima di questo momento.
    await expect(
      auth.updateProfile('33333333-3333-4333-8333-333333333333', { name: 'Nessuno' }),
    ).rejects.toBeInstanceOf(UnknownUserError);
  });

  it('non tocca il ruolo, che non è un campo aggiornabile dal profilo', async () => {
    const { user } = await auth.register(PASSENGER);

    await auth.updateProfile(user.id, { name: 'Giulietta' });

    // `ProfileUpdate` non ha un campo `role`, quindi non è un controllo a runtime ma una
    // proprietà del tipo. Il test esiste perché il giorno in cui qualcuno lo aggiungesse
    // «per comodità», un passeggero potrebbe promuoversi a operatore da solo.
    const [record] = await persistence.find('user', { where: { id: user.id } });
    expect(record?.role).toBe('PASSENGER');
  });
});
