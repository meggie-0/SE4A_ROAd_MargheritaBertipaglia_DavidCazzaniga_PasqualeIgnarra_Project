import { Test, type TestingModule } from '@nestjs/testing';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { DataSource, type QueryRunner } from 'typeorm';

import { AllocationModule } from '../../src/allocation/allocation.module';
import { AllocationPort } from '../../src/allocation/allocation.port';
import { AuthModule } from '../../src/auth/auth.module';
import { AuthPort } from '../../src/auth/auth.port';
import { ExternalModule } from '../../src/external/external.module';
import { ExternalServicesPort } from '../../src/external/external-services.port';
import { FleetSimulationPort } from '../../src/external/fleet-simulation.port';
import { FleetModule } from '../../src/fleet/fleet.module';
import { FleetMonitorPort } from '../../src/fleet/fleet-monitor.port';
import { MaintenanceModule } from '../../src/maintenance/maintenance.module';
import { MaintenancePort } from '../../src/maintenance/maintenance.port';
import { ModeModule } from '../../src/mode/mode.module';
import { ModePort } from '../../src/mode/mode.port';
import { TrafficMonitorPort } from '../../src/mode/traffic-monitor.port';
import { RebalancingModule } from '../../src/rebalancing/rebalancing.module';
import { RebalancingPort } from '../../src/rebalancing/rebalancing.port';
import { PersistenceModule } from '../../src/persistence/persistence.module';
import { PersistencePort, type TimeWindow } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { FakeClock } from '../../src/platform/fake-clock';
import { NotificationsModule } from '../../src/notifications/notifications.module';
import { NotificationSessionPort } from '../../src/notifications/session.port';
import { AdvanceBookingActivatorPort } from '../../src/rides/advance-booking.port';
import { FleetTelemetryPort } from '../../src/rides/fleet-telemetry.port';
import { RideLifecyclePort } from '../../src/rides/ride-lifecycle.port';
import { RidesModule } from '../../src/rides/rides.module';
import { RideRequestPort } from '../../src/rides/rides.port';

/**
 * Un Postgres vero, usa e getta, con lo schema di ROAd già applicato e i moduli di dominio
 * composti sopra (HARNESS.md §2).
 *
 * Il vincolo di esclusione che M1 deve garantire **non esiste** su un doppio in memoria: è una
 * funzione del database. Testarlo su un finto significherebbe testare il finto, e il difetto
 * arriverebbe in produzione intatto. Vale lo stesso per lo stato del veicolo di M2, che deve
 * sopravvivere a un giro di persistenza e ricostruzione: su un doppio sopravviverebbe da solo,
 * perché non andrebbe mai davvero via.
 *
 * Ogni modulo si raggiunge **solo** attraverso la sua porta: nessun test conosce le entità TypeORM,
 * il `DataSource` o il `FleetMonitor` concreto (CLAUDE.md Regola 1, HARNESS.md §3). La connessione
 * `openRawConnection()` che l'harness offre è un'altra cosa — è un client verso il *database*,
 * non verso un modulo, e serve ai test che devono decidere loro l'ordine con cui due transazioni
 * si intrecciano.
 */
export interface ApiHarness {
  /** Le porte: l'unico modo in cui i test parlano con i moduli. */
  readonly persistence: PersistencePort;
  readonly auth: AuthPort;
  readonly fleet: FleetMonitorPort;
  readonly maintenance: MaintenancePort;
  readonly allocation: AllocationPort;
  readonly rides: RideRequestPort;
  /**
   * L'attivatore delle prenotazioni (M4).
   *
   * `RidesModule` si compone **senza** `ScheduleModule`, quindi il suo `@Cron` resta inerte: le
   * prenotazioni si attivano solo quando un test chiama `runOnce()`, con l'istante che decide lui.
   */
  readonly advanceBooking: AdvanceBookingActivatorPort;
  /**
   * L'avanzamento di una corsa assegnata (M5): le transizioni 4-7 della Figura 2.10.
   *
   * Come `runOnce()`, in produzione la chiamerà qualcun altro — la telemetria del simulatore, da
   * M7 — e nei test la chiama il test, che decide lui quando un veicolo arriva.
   */
  readonly rideLifecycle: RideLifecyclePort;
  /** Il registro delle sessioni push, per registrare e deregistrare subscriber nei test (M5). */
  readonly notificationSessions: NotificationSessionPort;
  /**
   * La telemetria che fa avanzare le corse (M7).
   *
   * `RidesModule` si compone senza `ScheduleModule`, quindi il `@Cron` resta inerte: le corse
   * avanzano solo quando un test chiama `runOnce()`, dopo aver fatto muovere i veicoli.
   */
  readonly fleetTelemetry: FleetTelemetryPort;
  /**
   * I servizi esterni **veri**, composti come in produzione (M7).
   *
   * Senza `OSRM_BASE_URL` l'adapter delle mappe stima in linea d'aria e non tocca la rete; con
   * l'ambiente configurato verso un OSRM raggiungibile parla con quello. La flotta è il simulatore.
   */
  readonly external: ExternalServicesPort;
  /**
   * Il comando che fa avanzare il mondo simulato (M7).
   *
   * È l'unico modo in cui un test muove un veicolo, e passa da una porta come tutto il resto: il
   * simulatore «sotto test avanza solo su `tick()` esplicito» (MILESTONES.md §M7).
   */
  readonly simulation: FleetSimulationPort;
  /** Modo di controllo e isteresi (M6): i livelli di traffico li passa il test, uno per volta. */
  readonly mode: ModePort;
  /**
   * La lettura periodica del traffico (M6).
   *
   * `ModeModule` si compone **senza** `ScheduleModule`, quindi il suo `@Cron` resta inerte: il
   * traffico si legge solo quando un test chiama `runOnce()`, e il livello che ne esce dipende
   * dall'ora del `FakeClock` — cioè dal test.
   */
  readonly trafficMonitor: TrafficMonitorPort;
  /** Analisi della domanda e ciclo di riposizionamento (M6). */
  readonly rebalancing: RebalancingPort;
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
  'rebalancing_action',
  'ride',
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

/**
 * L'ambiente che `auth` si aspetta (M1b), fissato qui per tutta la suite.
 *
 * Il segreto è un valore di test qualunque, purché lungo abbastanza da superare il controllo di
 * `jwt.config.ts`; i cicli di bcrypt scendono al minimo di 4, perché con i 12 di produzione una
 * suite che registra decine di utenti passerebbe più tempo dentro bcrypt che nel codice che sta
 * verificando. Sono i **soli** parametri abbassati: la lunghezza minima della password, la
 * struttura del token e la verifica della firma restano quelle vere.
 */
function configureAuthEnvironment(): void {
  process.env.JWT_SECRET ??= 'segreto-di-test-abbastanza-lungo-per-hs256-0123456789';
  process.env.JWT_EXPIRES_IN_SECONDS ??= '3600';
  process.env.BCRYPT_ROUNDS = '4';
}

export async function startApiHarness(now = '2026-05-04T09:00:00.000Z'): Promise<ApiHarness> {
  configureAuthEnvironment();

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
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [
      PersistenceModule,
      AuthModule,
      ExternalModule,
      FleetModule,
      MaintenanceModule,
      AllocationModule,
      NotificationsModule,
      RidesModule,
      ModeModule,
      RebalancingModule,
    ],
  })
    .overrideProvider(ClockPort)
    .useValue(clock)
    .compile();

  const persistence = moduleRef.get(PersistencePort);
  const auth = moduleRef.get(AuthPort);
  const fleet = moduleRef.get(FleetMonitorPort);
  const maintenance = moduleRef.get(MaintenancePort);
  const allocation = moduleRef.get(AllocationPort);
  const rides = moduleRef.get(RideRequestPort);
  const advanceBooking = moduleRef.get(AdvanceBookingActivatorPort);
  const rideLifecycle = moduleRef.get(RideLifecyclePort);
  const notificationSessions = moduleRef.get(NotificationSessionPort);
  const fleetTelemetry = moduleRef.get(FleetTelemetryPort);
  const external = moduleRef.get(ExternalServicesPort);
  const simulation = moduleRef.get(FleetSimulationPort);
  const mode = moduleRef.get(ModePort);
  const trafficMonitor = moduleRef.get(TrafficMonitorPort);
  const rebalancing = moduleRef.get(RebalancingPort);

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
    auth,
    fleet,
    maintenance,
    allocation,
    rides,
    advanceBooking,
    rideLifecycle,
    notificationSessions,
    fleetTelemetry,
    external,
    simulation,
    mode,
    trafficMonitor,
    rebalancing,
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

      /**
       * Anche il **mondo simulato** si svuota, e non è una precauzione teorica (M7).
       *
       * Il simulatore è la flotta, non una vista del database: le posizioni dei veicoli vivono
       * nella sua memoria e a un `TRUNCATE` non succede niente. Senza questa riga, un test
       * troverebbe i veicoli dove li ha lasciati quello precedente e arriverebbe a destinazione
       * con qualche tick di anticipo — cioè la suite dipenderebbe dall'ordine di esecuzione,
       * che HARNESS.md §2 vieta. Scoperto proprio così, scrivendo il cancello di M7.
       */
      simulation.reset();

      // `system_mode` non si svuota — la riga singleton nasce con lo schema — ma si riporta al
      // default, o l'esito di un test dipenderebbe da quello che ha scritto il test precedente.
      await admin.query(
        `UPDATE "system_mode"
            SET "active_strategy" = 'NEAREST_AVAILABLE', "mode" = 'AUTO', "last_traffic_level" = NULL`,
      );
      // Da M3 quella riga ha uno scrittore vero — `AllocationPort.setActiveStrategy()` — quindi
      // riportarla al default fra un test e l'altro non è più una precauzione teorica.
    },

    async stop(): Promise<void> {
      await admin.destroy();
      await moduleRef.close();
      await container.stop();
    },
  };
}
