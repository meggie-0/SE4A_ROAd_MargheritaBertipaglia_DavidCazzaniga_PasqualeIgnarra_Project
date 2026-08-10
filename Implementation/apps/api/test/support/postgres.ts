import { Test, type TestingModule } from '@nestjs/testing';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DataSource, type QueryRunner } from 'typeorm';

import { PersistenceModule } from '../../src/persistence/persistence.module';
import { PersistencePort, type TimeWindow } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { FakeClock } from '../../src/platform/fake-clock';

/**
 * Un Postgres vero, usa e getta, con lo schema di ROAd già applicato (HARNESS.md §2).
 *
 * Il vincolo di esclusione che questa milestone deve garantire **non esiste** su un doppio in
 * memoria: è una funzione del database. Testarlo su un finto significherebbe testare il finto, e
 * il difetto arriverebbe in produzione intatto. Per questo i test di M1 partono da un container
 * pulito, con le migrazioni applicate e nessun dato residuo.
 *
 * Il modulo si raggiunge **solo** attraverso `PersistencePort`: nessun test conosce le entità
 * TypeORM né il `DataSource` del modulo (CLAUDE.md Regola 1, HARNESS.md §3). La connessione
 * `openRawConnection()` che l'harness offre è un'altra cosa — è un client verso il *database*,
 * non verso il modulo, e serve ai test che devono decidere loro l'ordine con cui due transazioni
 * si intrecciano.
 */
export interface PersistenceHarness {
  /** La porta: l'unico modo in cui i test parlano con il modulo. */
  readonly persistence: PersistencePort;
  /** L'orologio del modulo, sotto il controllo del test (CLAUDE.md Regola 3). */
  readonly clock: FakeClock;
  readonly databaseUrl: string;
  /** Una connessione dedicata al database, per controllare l'interleaving fra transazioni. */
  openRawConnection(): Promise<QueryRunner>;
  /**
   * SQL diretto, per asserire lo *stato del database* — che una transazione non abbia lasciato
   * metà lavoro, che un vincolo esista. Non è una scorciatoia per raggiungere il modulo: ciò che
   * il modulo fa si chiede alla porta.
   */
  query<Row>(sql: string, parameters?: readonly unknown[]): Promise<Row[]>;
  /** Quante righe ha una tabella. */
  countRows(table: string): Promise<number>;
  /** Svuota le tabelle di dominio: nessun test deve dipendere da ciò che ha lasciato un altro. */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

/** L'ordine conta: le figlie prima delle madri, o le chiavi esterne si oppongono. */
const DOMAIN_TABLES = [
  'notification',
  'booking',
  'robotaxi_reservation',
  'ride_request',
  'maintenance_record',
  'demand_event',
  'demand_sample',
  'robotaxi',
  'user',
  'zone',
];

/** Una finestra qualsiasi: serve solo a costringere il modulo ad aprire la connessione. */
const WARMUP_WINDOW: TimeWindow = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-01T01:00:00.000Z'),
};

export async function startPersistence(
  now = '2026-05-04T09:00:00.000Z',
): Promise<PersistenceHarness> {
  const container: StartedTestContainer = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_USER: 'road', POSTGRES_PASSWORD: 'road', POSTGRES_DB: 'road' })
    .withExposedPorts(5432)
    // Postgres annuncia due volte di essere pronto: la prima è il server temporaneo che l'immagine
    // usa per inizializzarsi, e connettersi a quello significa trovare la porta chiusa un istante
    // dopo. Si aspetta la seconda.
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();

  const databaseUrl = `postgres://road:road@${container.getHost()}:${container.getMappedPort(5432)}/road`;
  process.env.DATABASE_URL = databaseUrl;

  const clock = new FakeClock(now);
  const moduleRef: TestingModule = await Test.createTestingModule({ imports: [PersistenceModule] })
    .overrideProvider(ClockPort)
    .useValue(clock)
    .compile();

  const persistence = moduleRef.get(PersistencePort);

  // La connessione del modulo è pigra e porta con sé le migrazioni: la prima operazione vera è
  // ciò che crea lo schema. Va fatta qui, o il `reset()` del primo test troverebbe un database
  // vuoto e fallirebbe parlando d'altro.
  await persistence.filterAvailable(['nessun-veicolo'], WARMUP_WINDOW);

  // Connessione di servizio, separata da quella del modulo: svuota le tabelle fra un test e
  // l'altro e presta connessioni ai test che governano l'interleaving.
  const admin = new DataSource({
    type: 'postgres',
    url: databaseUrl,
    entities: [],
    synchronize: false,
  });
  await admin.initialize();

  return {
    persistence,
    clock,
    databaseUrl,

    async openRawConnection(): Promise<QueryRunner> {
      const runner = admin.createQueryRunner();
      await runner.connect();
      return runner;
    },

    async query<Row>(sql: string, parameters: readonly unknown[] = []): Promise<Row[]> {
      return admin.query(sql, [...parameters]);
    },

    async countRows(table: string): Promise<number> {
      const rows: ReadonlyArray<{ total: string }> = await admin.query(
        `SELECT count(*)::text AS total FROM "${table}"`,
      );
      return Number.parseInt(rows[0]?.total ?? '0', 10);
    },

    async reset(): Promise<void> {
      const quoted = DOMAIN_TABLES.map((table) => `"${table}"`).join(', ');
      await admin.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

      // `system_mode` non si svuota — la riga singleton nasce con lo schema — ma si riporta al
      // default, o l'esito di un test dipenderebbe da quello che ha scritto il test precedente.
      await admin.query(
        `UPDATE "system_mode"
            SET "active_strategy" = 'NEAREST_AVAILABLE', "mode" = 'AUTO', "last_traffic_level" = NULL`,
      );
    },

    async stop(): Promise<void> {
      await admin.destroy();
      await moduleRef.close();
      await container.stop();
    },
  };
}
