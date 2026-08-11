import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { API_ROUTES, rideCancelRoute } from '@road/shared';
import request from 'supertest';

import { GatewayModule } from '../../src/gateway/gateway.module';
import { activationDueAt, type PersistencePort } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import type { AdvanceBookingActivatorPort } from '../../src/rides/advance-booking.port';
import type { RideRequestPort } from '../../src/rides/rides.port';
import { startApiHarness, type ApiHarness } from '../support/postgres';

/**
 * Cancello di M4 (MILESTONES.md §M4, HARNESS.md §6).
 *
 * Criterio di completamento, tradotto in test:
 *   - la catena **richiesta → allocazione → assegnazione** si completa (R3, G2);
 *   - una prenotazione anticipata **o scrive entrambe le righe o nessuna**, verificato forzando un
 *     errore a metà transazione (R4, G3, NFR4);
 *   - l'annullamento rilascia la riserva e **la finestra torna prenotabile** (R14);
 *   - `runOnce()` su un orologio finto attiva una prenotazione dovuta, e ne **ri-alloca** una il cui
 *     veicolo è finito in manutenzione nel frattempo (R4, decisione D9).
 *
 * Gira per intero su **Postgres vero**: ciò che questo cancello deve dimostrare — l'atomicità di
 * una transazione, il rilascio di una riserva che torna prenotabile, una catena che attraversa
 * quattro moduli — su un doppio in memoria si verificherebbe contro il doppio. **Serve Docker in
 * esecuzione.** L'ultima parte passa dall'HTTP pubblico, perché una milestone che pubblica endpoint
 * non è finita finché un client non li usa come li userà l'app passeggero di M8.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };

/** L'orario di una prenotazione: due ore dopo `NOW`, quindi attivazione dovuta alle 10:45. */
const PICKUP_AT = new Date('2026-05-04T11:00:00.000Z');
const DUE_AT = activationDueAt(PICKUP_AT);

const PASSENGER = {
  email: 'giulia.rossi@example.com',
  password: 'password-di-prova',
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};

const OPERATOR = {
  email: 'ada.operatrice@example.com',
  password: 'password-operatrice',
  name: 'Ada',
  surname: 'Operatrice',
  phoneNumber: null,
  role: 'OPERATOR' as const,
};

let harness: ApiHarness;
let api: INestApplication;
let persistence: PersistencePort;
let rides: RideRequestPort;
let advanceBooking: AdvanceBookingActivatorPort;
let passengerId: string;
let passengerToken: string;

/** Un veicolo disponibile a `degrees` gradi di latitudine a nord del Duomo (0,01° ≈ 1,1 km). */
async function givenRobotaxi(id: string, degrees: number): Promise<void> {
  await persistence.create('robotaxi', {
    id,
    state: 'AVAILABLE',
    lat: DUOMO.lat + degrees,
    lon: DUOMO.lon,
    zoneId: 'duomo',
  });
}

/** Lo stato scritto in colonna, letto senza passare dal modulo. */
async function persistedState(id: string): Promise<string | undefined> {
  const rows = await harness.query<{ state: string }>(
    `SELECT "state" FROM "robotaxi" WHERE "id" = $1`,
    [id],
  );
  return rows[0]?.state;
}

async function login(email: string, password: string): Promise<string> {
  const response = await request(api.getHttpServer())
    .post(API_ROUTES.authLogin)
    .send({ email, password })
    .expect(200);
  return (response.body as { accessToken: string }).accessToken;
}

const immediateDraft = () => ({
  passengerId,
  pickup: DUOMO,
  destination: CENTRALE,
});

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  persistence = harness.persistence;
  rides = harness.rides;
  advanceBooking = harness.advanceBooking;

  const moduleRef = await Test.createTestingModule({ imports: [GatewayModule] })
    .overrideProvider(ClockPort)
    .useValue(harness.clock)
    .compile();
  api = moduleRef.createNestApplication({ logger: false });
  await api.init();
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await api?.close();
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);

  await persistence.create('zone', { id: 'duomo', name: 'Duomo / Centro', ...DUOMO });
  const registered = await harness.auth.register(PASSENGER);
  passengerId = registered.user.id;
  passengerToken = await login(PASSENGER.email, PASSENGER.password);
});

describe('[M4] Cancello: RideRequestManager', () => {
  describe('[R3][G2] La catena richiesta → allocazione → assegnazione', () => {
    it('si completa, e lascia il database in uno stato coerente', async () => {
      await givenRobotaxi('RT-01', 0.05);
      await givenRobotaxi('RT-02', 0.01);

      const outcome = await rides.submitImmediate(immediateDraft());

      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted) return;

      // Ha scelto la strategia attiva — `NEAREST_AVAILABLE` di default — e non il primo id
      // disponibile: RT-02 è il più vicino al punto di ritiro.
      expect(outcome.robotaxiId).toBe('RT-02');

      // I quattro effetti della Figura 2.5, letti dal database e non dall'esito della chiamata.
      const [row] = await harness.query<{ status: string; assigned_robotaxi_id: string | null }>(
        `SELECT "status", "assigned_robotaxi_id" FROM "ride_request" WHERE "id" = $1`,
        [outcome.request.id],
      );
      expect(row).toMatchObject({ status: 'ACCEPTED', assigned_robotaxi_id: 'RT-02' });
      expect(await persistedState('RT-02')).toBe('ASSIGNED');
      expect(await persistedState('RT-01')).toBe('AVAILABLE');

      const reservations = await persistence.find('robotaxi_reservation', {
        where: { rideRequestId: outcome.request.id },
      });
      expect(reservations).toHaveLength(1);
      // La riserva copre un intervallo **limitato** che comincia adesso (decisione D8): con un
      // estremo superiore aperto, questo veicolo non sarebbe mai più prenotabile.
      expect(reservations[0]?.period.start).toEqual(NOW);
      expect(reservations[0]?.period.end.getTime()).toBeGreaterThan(NOW.getTime());
      expect(reservations[0]?.releasedAt).toBeNull();
    });

    it('e un veicolo in manutenzione non entra nella catena', async () => {
      await givenRobotaxi('RT-01', 0.01);
      await givenRobotaxi('RT-02', 0.05);
      await harness.maintenance.requestMaintenance('RT-01', 'freni');

      const outcome = await rides.submitImmediate(immediateDraft());

      // RT-01 sarebbe il più vicino: non è candidato perché il suo stato non è allocabile, che è
      // il modo in cui R9 è realizzato (M2).
      expect(outcome.accepted && outcome.robotaxiId).toBe('RT-02');
    });

    it('senza veicoli idonei la richiesta è rifiutata e resta scritta', async () => {
      const outcome = await rides.submitImmediate(immediateDraft());

      expect(outcome.accepted).toBe(false);
      expect(outcome.request.status).toBe('REJECTED');
      expect(await harness.countRows('ride_request')).toBe(1);
      expect(await harness.countRows('robotaxi_reservation')).toBe(0);
    });
  });

  describe('[R4][G3][NFR4] La prenotazione anticipata scrive entrambe le righe o nessuna', () => {
    it('accettata, prenotazione e riserva esistono entrambe e si puntano', async () => {
      await givenRobotaxi('RT-01', 0.01);

      const outcome = await rides.submitAdvance({
        ...immediateDraft(),
        scheduledPickup: PICKUP_AT,
      });

      expect(outcome.accepted).toBe(true);
      if (!outcome.accepted || outcome.booking === null) return;

      expect(await harness.countRows('booking')).toBe(1);
      expect(await harness.countRows('robotaxi_reservation')).toBe(1);
      expect(outcome.booking.reservationId).toBe(outcome.reservation.id);
      expect(outcome.booking.rideRequestId).toBe(outcome.request.id);
      expect(outcome.booking.activationDueAt).toEqual(DUE_AT);

      // Il veicolo è riservato, **non** assegnato: lo sarà all'attivazione (decisione D9).
      expect(await persistedState('RT-01')).toBe('AVAILABLE');
      expect(outcome.request.assignedRobotaxiId).toBeNull();
    });

    it('un errore a metà transazione non lascia nessuna delle due righe', async () => {
      await givenRobotaxi('RT-01', 0.01);

      /**
       * L'errore si forza sulla **seconda** scrittura della transazione.
       *
       * `reserve()` inserisce prima la riserva e poi la prenotazione. Qui la prenotazione viola il
       * vincolo `booking_activation_precedes_pickup` — attivazione dopo l'orario del prelievo —,
       * quindi il rifiuto arriva quando la riga di riserva è già stata scritta. Se la transazione
       * non fosse una sola, resterebbe una riserva orfana: un veicolo impegnato per una
       * prenotazione che non esiste, invisibile a chiunque e impossibile da liberare.
       */
      await expect(
        persistence.reserve({
          robotaxiId: 'RT-01',
          rideRequestId: (await rides.submitImmediate(immediateDraft())).request.id,
          window: { start: PICKUP_AT, end: new Date(PICKUP_AT.getTime() + 3_600_000) },
          booking: {
            robotaxiId: 'RT-01',
            scheduledPickup: PICKUP_AT,
            activationDueAt: new Date(PICKUP_AT.getTime() + 60_000),
            activatedAt: null,
          },
        }),
      ).rejects.toThrow();

      expect(await harness.countRows('booking')).toBe(0);
      // La sola riserva presente è quella della corsa immediata usata per avere un identificatore
      // di richiesta valido: quella della transazione fallita non c'è.
      const orphans = await harness.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM "robotaxi_reservation"
          WHERE lower("period") = $1`,
        [PICKUP_AT.toISOString()],
      );
      expect(orphans[0]?.total).toBe('0');
    });

    it('due prenotazioni sulla stessa finestra non ottengono lo stesso veicolo', async () => {
      await givenRobotaxi('RT-01', 0.01);

      const first = await rides.submitAdvance({ ...immediateDraft(), scheduledPickup: PICKUP_AT });
      const second = await rides.submitAdvance({ ...immediateDraft(), scheduledPickup: PICKUP_AT });

      expect(first.accepted).toBe(true);
      // Un solo veicolo in flotta, già riservato in quella finestra: `filterAvailable` lo esclude,
      // e il vincolo di esclusione lo escluderebbe comunque.
      expect(second.accepted).toBe(false);
      expect(await harness.countRows('booking')).toBe(1);
    });
  });

  describe('[R14] L annullamento libera la riserva e la finestra torna prenotabile', () => {
    it('riporta il veicolo ad available e rilascia la riserva', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const outcome = await rides.submitImmediate(immediateDraft());

      const cancellation = await rides.cancel(outcome.request.id, passengerId);

      expect(cancellation.request.status).toBe('CANCELLED');
      expect(cancellation.releasedRobotaxiId).toBe('RT-01');
      // Transizione 11 della Figura 2.10, scritta in colonna (decisione D27).
      expect(await persistedState('RT-01')).toBe('AVAILABLE');

      const [reservation] = await persistence.find('robotaxi_reservation', {
        where: { rideRequestId: outcome.request.id },
      });
      expect(reservation?.releasedAt).not.toBeNull();
    });

    it('e la finestra liberata è di nuovo prenotabile — sullo stesso veicolo', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const first = await rides.submitImmediate(immediateDraft());
      await rides.cancel(first.request.id, passengerId);

      // È l'effetto osservabile che R14 enuncia, e la ragione per cui una riserva si **rilascia**
      // invece di accorciarsi (decisione D19): con un solo veicolo in flotta, senza il rilascio
      // questa seconda richiesta non troverebbe nessuno.
      const second = await rides.submitImmediate(immediateDraft());

      expect(second.accepted && second.robotaxiId).toBe('RT-01');
      expect(await persistedState('RT-01')).toBe('ASSIGNED');
    });

    it('la stessa cosa vale per una prenotazione annullata prima della sua finestra', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const booked = await rides.submitAdvance({
        ...immediateDraft(),
        scheduledPickup: PICKUP_AT,
      });

      await rides.cancel(booked.request.id, passengerId);
      const again = await rides.submitAdvance({ ...immediateDraft(), scheduledPickup: PICKUP_AT });

      // Annullare *prima* dell'inizio della finestra non è esprimibile accorciando l'intervallo:
      // servirebbe un intervallo vuoto, che lo schema vieta. Il rilascio restituisce tutto.
      expect(again.accepted && again.robotaxiId).toBe('RT-01');
    });
  });

  describe('[R4][G3] runOnce() attiva le prenotazioni dovute e ri-alloca quando serve', () => {
    it('attiva una prenotazione dovuta, su un orologio finto', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const booked = await rides.submitAdvance({
        ...immediateDraft(),
        scheduledPickup: PICKUP_AT,
      });

      // Prima dell'istante dovuto non succede niente: l'anticipo è il patto fatto col passeggero.
      expect(
        (await advanceBooking.runOnce(new Date(DUE_AT.getTime() - 60_000))).activations,
      ).toEqual([]);
      expect(await persistedState('RT-01')).toBe('AVAILABLE');

      const report = await advanceBooking.runOnce(DUE_AT);

      expect(report.activations).toHaveLength(1);
      expect(report.activations[0]).toMatchObject({
        rideRequestId: booked.request.id,
        outcome: 'ACTIVATED',
        robotaxiId: 'RT-01',
      });
      expect(await persistedState('RT-01')).toBe('ASSIGNED');

      const [booking] = await persistence.find('booking', {
        where: { rideRequestId: booked.request.id },
      });
      expect(booking?.activatedAt).toEqual(DUE_AT);
    });

    it('ri-alloca la prenotazione il cui veicolo è finito in manutenzione', async () => {
      await givenRobotaxi('RT-01', 0.01);
      await givenRobotaxi('RT-02', 0.05);

      const booked = await rides.submitAdvance({
        ...immediateDraft(),
        scheduledPickup: PICKUP_AT,
      });
      expect(booked.accepted && booked.robotaxiId).toBe('RT-01');

      // Fra la prenotazione e l'orario, il veicolo riservato va in officina (R9).
      await harness.maintenance.requestMaintenance('RT-01', 'freni');

      const report = await advanceBooking.runOnce(DUE_AT);

      expect(report.activations[0]).toMatchObject({
        rideRequestId: booked.request.id,
        outcome: 'REALLOCATED',
        robotaxiId: 'RT-02',
      });
      expect(await persistedState('RT-02')).toBe('ASSIGNED');
      expect(await persistedState('RT-01')).toBe('MAINTENANCE');

      // La riserva del veicolo in officina è stata rilasciata, quella nuova no.
      const reservations = await persistence.find('robotaxi_reservation', {
        where: { rideRequestId: booked.request.id },
        orderBy: [{ field: 'createdAt' }],
      });
      expect(reservations).toHaveLength(2);
      expect(reservations.find((row) => row.robotaxiId === 'RT-01')?.releasedAt).not.toBeNull();
      expect(reservations.find((row) => row.robotaxiId === 'RT-02')?.releasedAt).toBeNull();

      const [booking] = await persistence.find('booking', {
        where: { rideRequestId: booked.request.id },
      });
      expect(booking?.robotaxiId).toBe('RT-02');
    });

    it('se nessun veicolo è idoneo la richiesta è rifiutata, e non si riprova all infinito', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const booked = await rides.submitAdvance({
        ...immediateDraft(),
        scheduledPickup: PICKUP_AT,
      });
      await harness.maintenance.requestMaintenance('RT-01', 'freni');

      const first = await advanceBooking.runOnce(DUE_AT);
      expect(first.activations[0]).toMatchObject({ outcome: 'REJECTED', robotaxiId: null });

      const [rejected] = await persistence.find('ride_request', {
        where: { id: booked.request.id },
      });
      expect(rejected?.status).toBe('REJECTED');

      // Il veicolo torna disponibile, ma la richiesta rifiutata non viene ripescata: sarebbe una
      // corsa che il passeggero ha già saputo di non avere.
      await harness.maintenance.completeMaintenance('RT-01');
      const second = await advanceBooking.runOnce(new Date(DUE_AT.getTime() + 60_000));
      expect(second.activations).toEqual([]);
    });
  });

  describe('[R3][R4][R14][G2][G3] Le tre operazioni sull HTTP pubblico', () => {
    it('un passeggero richiede una corsa e la vede assegnata', async () => {
      await givenRobotaxi('RT-01', 0.01);

      const response = await request(api.getHttpServer())
        .post(API_ROUTES.ridesImmediate)
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ pickup: DUOMO, destination: CENTRALE, pickupAddress: 'Piazza del Duomo' })
        .expect(201);

      expect(response.body).toMatchObject({
        kind: 'IMMEDIATE',
        status: 'ACCEPTED',
        assignedRobotaxiId: 'RT-01',
        pickupAddress: 'Piazza del Duomo',
        scheduledPickup: null,
      });
    });

    it('prenota per un orario futuro, e un orario passato è una richiesta malformata', async () => {
      await givenRobotaxi('RT-01', 0.01);

      const booked = await request(api.getHttpServer())
        .post(API_ROUTES.ridesAdvance)
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ pickup: DUOMO, destination: CENTRALE, scheduledPickup: PICKUP_AT.toISOString() })
        .expect(201);

      expect(booked.body).toMatchObject({
        kind: 'ADVANCE',
        status: 'ACCEPTED',
        // Riservato, non ancora assegnato.
        assignedRobotaxiId: null,
        scheduledPickup: PICKUP_AT.toISOString(),
      });

      await request(api.getHttpServer())
        .post(API_ROUTES.ridesAdvance)
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({
          pickup: DUOMO,
          destination: CENTRALE,
          scheduledPickup: new Date(NOW.getTime() - 60_000).toISOString(),
        })
        .expect(400);
    });

    it('annulla la propria corsa, e non quella di un altro', async () => {
      await givenRobotaxi('RT-01', 0.01);
      const created = await request(api.getHttpServer())
        .post(API_ROUTES.ridesImmediate)
        .set('Authorization', `Bearer ${passengerToken}`)
        .send({ pickup: DUOMO, destination: CENTRALE })
        .expect(201);
      const rideRequestId = (created.body as { id: string }).id;

      const cancelled = await request(api.getHttpServer())
        .post(rideCancelRoute(rideRequestId))
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(200);
      expect(cancelled.body).toMatchObject({ status: 'CANCELLED', assignedRobotaxiId: null });

      // Annullare due volte è un conflitto, non un guasto.
      await request(api.getHttpServer())
        .post(rideCancelRoute(rideRequestId))
        .set('Authorization', `Bearer ${passengerToken}`)
        .expect(409);

      // La corsa di un altro passeggero non esiste: 404, non 403.
      await harness.auth.register({ ...PASSENGER, email: 'altro@example.com' });
      const otherToken = await login('altro@example.com', PASSENGER.password);
      await request(api.getHttpServer())
        .post(rideCancelRoute(rideRequestId))
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404);
    });

    it('un operatore non richiede corse, e senza token non le richiede nessuno', async () => {
      await harness.auth.register(OPERATOR);
      const operatorToken = await login(OPERATOR.email, OPERATOR.password);

      await request(api.getHttpServer())
        .post(API_ROUTES.ridesImmediate)
        .set('Authorization', `Bearer ${operatorToken}`)
        .send({ pickup: DUOMO, destination: CENTRALE })
        .expect(403);

      await request(api.getHttpServer())
        .post(API_ROUTES.ridesImmediate)
        .send({ pickup: DUOMO, destination: CENTRALE })
        .expect(401);

      expect(await harness.countRows('ride_request')).toBe(0);
    });
  });
});
