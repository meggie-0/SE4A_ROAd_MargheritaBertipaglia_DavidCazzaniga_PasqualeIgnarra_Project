import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { MILAN_ZONES, nearestZone } from '@road/shared';

import {
  immediateReservationWindow,
  type PersistencePort,
  type TimeWindow,
} from '../../src/persistence/persistence.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M1 (MILESTONES.md §M1, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - due transazioni concorrenti che prenotano lo stesso veicolo su intervalli sovrapposti:
 *     esattamente una riesce, l'altra fallisce **per violazione del vincolo di esclusione**;
 *   - `filterAvailable` esclude i veicoli già riservati nella finestra richiesta.
 *
 * Attorno a quei due punti il cancello verifica ciò senza cui non sarebbero veri: che lo schema
 * esista davvero con le sue undici tabelle, che il vincolo sia quello dichiarato (e non un
 * controllo applicativo travestito), che gli intervalli siano limitati come impone la decisione
 * D8, e che `pnpm db:seed` produca i dati di partenza che il README promette.
 *
 * **Serve Docker in esecuzione.** Il vincolo di esclusione è una funzione di PostgreSQL: su un
 * doppio in memoria non esiste, e un cancello che lo verificasse su un finto verificherebbe il
 * finto.
 */

const repoRoot = resolve(__dirname, '..', '..', '..', '..');

/** Le undici tabelle elencate in MILESTONES.md §M1. */
const EXPECTED_TABLES = [
  'booking',
  'demand_event',
  'demand_sample',
  'maintenance_record',
  'notification',
  'ride_request',
  'robotaxi',
  'robotaxi_reservation',
  'system_mode',
  'user',
  'zone',
];

const NOW = new Date('2026-05-04T09:00:00.000Z');
const WINDOW: TimeWindow = immediateReservationWindow(NOW, 5, 20);
const OVERLAPPING: TimeWindow = immediateReservationWindow(
  new Date('2026-05-04T09:15:00.000Z'),
  5,
  20,
);

/** Avviare un container Postgres a freddo non sta nei 5 secondi di default dei hook di Jest. */
const HOOK_TIMEOUT_MS = 180_000;
/** Il seed compila l'API e scrive qualche migliaio di righe: gli serve più aria di un test normale. */
const SEED_TIMEOUT_MS = 300_000;

let harness: ApiHarness;
let persistence: PersistencePort;

/** Lo SQLSTATE di un errore del driver, comunque la libreria scelga di annidarlo. */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const candidate = error as { code?: string; driverError?: { code?: string } };
  return candidate.code ?? candidate.driverError?.code;
}

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  persistence = harness.persistence;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
});

/** Un veicolo e due richieste di corsa: il minimo per contendersi una finestra. */
async function givenOneRobotaxiAndTwoRequests(): Promise<[string, string]> {
  await persistence.create('zone', {
    id: 'duomo',
    name: 'Duomo / Centro',
    lat: 45.4642,
    lon: 9.19,
  });
  await persistence.create('robotaxi', {
    id: 'RT-01',
    state: 'AVAILABLE',
    lat: 45.4642,
    lon: 9.19,
    zoneId: 'duomo',
  });

  const requests: string[] = [];
  for (const email of ['anna@example.com', 'bruno@example.com']) {
    const passenger = await persistence.create('user', {
      email,
      passwordHash: 'non-una-password',
      name: 'Nome',
      surname: 'Cognome',
      phoneNumber: null,
      role: 'PASSENGER',
    });
    const request = await persistence.create('ride_request', {
      passengerId: passenger.id,
      kind: 'IMMEDIATE',
      status: 'PENDING',
      pickupLat: 45.4642,
      pickupLon: 9.19,
      pickupAddress: null,
      destinationLat: 45.4781,
      destinationLon: 9.227,
      destinationAddress: null,
      assignedRobotaxiId: null,
    });
    requests.push(request.id);
  }

  return [requests[0] as string, requests[1] as string];
}

describe('[M1] Cancello: schema e PersistenceManager', () => {
  describe('Schema', () => {
    it('le migrazioni creano le undici tabelle di MILESTONES.md §M1', async () => {
      const rows = await harness.query<{ table_name: string }>(
        `SELECT "table_name" FROM information_schema.tables WHERE "table_schema" = 'public'`,
      );
      const tables = rows.map((row) => row.table_name);

      for (const table of EXPECTED_TABLES) expect(tables).toContain(table);
    });

    it('installa btree_gist, senza cui il vincolo di esclusione non è esprimibile', async () => {
      const rows = await harness.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);

      expect(rows).toHaveLength(1);
    });

    it('dichiara no_overlapping_reservations come vincolo di esclusione parziale', async () => {
      // `contype = 'x'` è un vincolo di esclusione. Se domani qualcuno lo sostituisse con un
      // indice unico o con un controllo applicativo, questo test lo direbbe: la garanzia di NFR4
      // sta nel *tipo* di vincolo, non nel suo nome. La clausola `WHERE` è ciò che rende
      // possibile l'annullamento di R14: una riserva rilasciata esce dal vincolo.
      const rows = await harness.query<{ contype: string; definition: string }>(
        `SELECT "contype", pg_get_constraintdef("oid") AS definition
           FROM pg_constraint WHERE "conname" = 'no_overlapping_reservations'`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.contype).toBe('x');
      expect(rows[0]?.definition).toContain('released_at IS NULL');
    });
  });

  describe('[NFR4][G10] Il vincolo di esclusione sulle riserve', () => {
    it('rifiuta la seconda di due transazioni concorrenti sullo stesso veicolo', async () => {
      const [first, second] = await givenOneRobotaxiAndTwoRequests();

      const a = await harness.openRawConnection();
      const b = await harness.openRawConnection();

      try {
        await a.startTransaction();
        await b.startTransaction();

        const insert = (rideRequestId: string, window: TimeWindow): [string, unknown[]] => [
          `INSERT INTO "robotaxi_reservation"
             ("robotaxi_id", "ride_request_id", "period", "created_at")
           VALUES ('RT-01', $1, tstzrange($2::timestamptz, $3::timestamptz, '[)'), now())`,
          [rideRequestId, window.start.toISOString(), window.end.toISOString()],
        ];

        const [firstSql, firstParams] = insert(first, WINDOW);
        await a.query(firstSql, firstParams);

        // La seconda scrittura si sovrappone e resta **appesa** finché la prima non decide: è il
        // comportamento del vincolo di esclusione, che serializza gli scrittori invece di
        // lasciarli passare entrambi. L'esito si raccoglie senza `await`, o si aspetterebbe
        // qualcosa che dipende da un commit non ancora avvenuto.
        const [secondSql, secondParams] = insert(second, OVERLAPPING);
        const pending = b
          .query(secondSql, secondParams)
          .then(() => null)
          .catch((error: unknown) => error);

        await a.commitTransaction();
        const failure = await pending;

        expect(failure).not.toBeNull();
        expect(sqlState(failure)).toBe('23P01'); // exclusion_violation
        expect(String(failure)).toContain('no_overlapping_reservations');

        await b.rollbackTransaction();
      } finally {
        await a.release();
        await b.release();
      }

      // Esattamente una: quella che ha commesso per prima.
      expect(await harness.countRows('robotaxi_reservation')).toBe(1);
    });

    it('accetta due riserve dello stesso veicolo su finestre che non si sovrappongono', async () => {
      const [first, second] = await givenOneRobotaxiAndTwoRequests();

      const early = await persistence.reserve({
        robotaxiId: 'RT-01',
        rideRequestId: first,
        window: WINDOW,
      });
      const late = await persistence.reserve({
        robotaxiId: 'RT-01',
        rideRequestId: second,
        window: immediateReservationWindow(new Date('2026-05-04T14:00:00.000Z'), 5, 20),
      });

      // Il vincolo deve impedire le sovrapposizioni, non l'uso del veicolo: se rifiutasse anche
      // questa, la flotta sarebbe monouso.
      expect([early.reserved, late.reserved]).toEqual([true, true]);
      expect(await harness.countRows('robotaxi_reservation')).toBe(2);
    });

    it('lascia riprenotare la stessa finestra dopo che la riserva è stata rilasciata (R14)', async () => {
      const [first, second] = await givenOneRobotaxiAndTwoRequests();

      const outcome = await persistence.reserve({
        robotaxiId: 'RT-01',
        rideRequestId: first,
        window: WINDOW,
      });
      if (!outcome.reserved) throw new Error('la prima riserva doveva riuscire');

      // Annullamento: la finestra dev'essere di nuovo prenotabile *per intero*. Restringere
      // l'intervallo non basterebbe — un intervallo vuoto lo schema lo vieta — quindi la riserva
      // si rilascia e il vincolo, che è parziale, smette di considerarla.
      await persistence.update('robotaxi_reservation', outcome.reservation.id, { releasedAt: NOW });

      expect(await persistence.filterAvailable(['RT-01'], WINDOW)).toEqual(['RT-01']);
      const again = await persistence.reserve({
        robotaxiId: 'RT-01',
        rideRequestId: second,
        window: WINDOW,
      });

      expect(again.reserved).toBe(true);
      // Due righe, una sola attiva: lo storico resta.
      expect(await harness.countRows('robotaxi_reservation')).toBe(2);
    });

    it('rifiuta una riserva con un estremo illimitato (decisione D8)', async () => {
      const [first] = await givenOneRobotaxiAndTwoRequests();
      const connection = await harness.openRawConnection();

      try {
        // Un intervallo aperto in alto bloccherebbe ogni prenotazione futura su quel veicolo: lo
        // schema lo vieta, invece di affidarsi al fatto che nessun chiamante lo scriva mai.
        const attempt = connection
          .query(
            `INSERT INTO "robotaxi_reservation"
               ("robotaxi_id", "ride_request_id", "period", "created_at")
             VALUES ('RT-01', $1, tstzrange($2::timestamptz, NULL, '[)'), now())`,
            [first, WINDOW.start.toISOString()],
          )
          .then(() => null)
          .catch((error: unknown) => error);

        expect(await attempt).not.toBeNull();
      } finally {
        await connection.release();
      }

      expect(await harness.countRows('robotaxi_reservation')).toBe(0);
    });
  });

  describe('[NFR1][G10] Due richieste per l’ultimo veicolo disponibile', () => {
    it('esattamente una viene servita, e resta una sola riserva', async () => {
      const [first, second] = await givenOneRobotaxiAndTwoRequests();

      const outcomes = await Promise.all([
        persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: first, window: WINDOW }),
        persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: second, window: OVERLAPPING }),
      ]);

      const accepted = outcomes.filter((outcome) => outcome.reserved);
      const rejected = outcomes.filter((outcome) => !outcome.reserved);

      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(await harness.countRows('robotaxi_reservation')).toBe(1);

      // Il motivo dipende da chi arriva prima al blocco di riga, e le due possibilità sono
      // entrambe corrette: o il veicolo risulta impegnato da una transazione in corso
      // (`SKIP LOCKED`), o è il vincolo di esclusione a fermare la seconda scrittura. Il criterio
      // della milestone è "esattamente una riesce"; che il vincolo *funzioni* lo dimostra il test
      // con l'interleaving controllato qui sopra.
      expect(['ROBOTAXI_BUSY', 'OVERLAPPING_RESERVATION']).toContain(
        rejected[0]?.reserved === false ? rejected[0].reason : undefined,
      );
    });
  });

  describe('[NFR4][G10] filterAvailable esclude i veicoli già riservati', () => {
    it('toglie dai candidati chi ha una riserva sovrapposta e lascia gli altri', async () => {
      const [first] = await givenOneRobotaxiAndTwoRequests();
      await persistence.create('robotaxi', {
        id: 'RT-02',
        state: 'AVAILABLE',
        lat: 45.4642,
        lon: 9.19,
        zoneId: 'duomo',
      });

      expect(await persistence.filterAvailable(['RT-01', 'RT-02'], WINDOW)).toEqual([
        'RT-01',
        'RT-02',
      ]);

      await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: first, window: WINDOW });

      expect(await persistence.filterAvailable(['RT-01', 'RT-02'], OVERLAPPING)).toEqual(['RT-02']);
      // Fuori dalla finestra riservata il veicolo torna candidabile: la riserva è limitata.
      expect(
        await persistence.filterAvailable(
          ['RT-01', 'RT-02'],
          immediateReservationWindow(new Date('2026-05-04T14:00:00.000Z'), 5, 20),
        ),
      ).toEqual(['RT-01', 'RT-02']);
    });
  });

  describe('Dati di partenza', () => {
    it(
      'pnpm db:seed carica zone, flotta e domanda del prototipo',
      async () => {
        // Si esegue il comando vero, quello che il README chiede all'utente: è l'unico modo di
        // sapere che `pnpm db:migrate` e `pnpm db:seed` funzionano davvero, e non solo che
        // funzionerebbe il codice che invocano.
        const seed = spawnSync(`node "${join('tools', 'db', 'seed.mjs')}"`, {
          cwd: repoRoot,
          encoding: 'utf8',
          shell: true,
          env: { ...process.env, DATABASE_URL: harness.databaseUrl },
        });

        expect(`${seed.stdout ?? ''}${seed.stderr ?? ''}`).toContain('Zone: 16');
        expect(seed.status).toBe(0);

        expect(await harness.countRows('zone')).toBe(16);
        expect(await harness.countRows('robotaxi')).toBe(64);
        // 16 zone × 7 giorni × 24 ore: una settimana intera di domanda di base.
        expect(await harness.countRows('demand_sample')).toBe(16 * 7 * 24);
        expect(await harness.countRows('demand_event')).toBe(3);

        // Il seed dichiara la zona di ogni veicolo; la decisione D10 dice come calcolarla dalla
        // posizione. Se le due divergessero, il rebalancing di M6 lavorerebbe su un dato falso.
        // L'asserzione sta in questo test e non in uno suo: `beforeEach` svuota le tabelle, e un
        // secondo test troverebbe una flotta vuota e passerebbe senza verificare nulla.
        const fleet = await harness.query<{
          id: string;
          lat: number;
          lon: number;
          zone_id: string;
        }>(`SELECT "id", "lat", "lon", "zone_id" FROM "robotaxi" ORDER BY "id"`);
        expect(fleet).toHaveLength(64);
        for (const robotaxi of fleet) {
          expect(nearestZone(robotaxi, MILAN_ZONES)?.id).toBe(robotaxi.zone_id);
        }
      },
      SEED_TIMEOUT_MS,
    );
  });
});
