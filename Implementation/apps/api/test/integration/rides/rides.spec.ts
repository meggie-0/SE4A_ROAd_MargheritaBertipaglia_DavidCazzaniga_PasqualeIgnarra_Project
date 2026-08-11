import { activationDueAt, type PersistencePort } from '../../../src/persistence/persistence.port';
import type { AdvanceBookingActivatorPort } from '../../../src/rides/advance-booking.port';
import type { RideRequestPort } from '../../../src/rides/rides.port';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * Corse immediate e prenotazioni **sulla stessa timeline**, su Postgres vero (M4).
 *
 * È la proprietà che il DD §2.4 enuncia e che nessun altro test copre: «le Figure 2.5 e 2.8
 * finiscono entrambe in `reserve()`, quindi una corsa immediata e una prenotazione competono sulla
 * stessa timeline; è questo che rende C1 garantibile da un solo vincolo di database invece che dal
 * codice applicativo». Su un doppio in memoria si verificherebbe la riproduzione del vincolo; qui
 * a decidere è `EXCLUDE USING gist`, cioè la cosa vera.
 *
 * **Serve Docker in esecuzione.**
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };

let harness: ApiHarness;
let persistence: PersistencePort;
let rides: RideRequestPort;
let advanceBooking: AdvanceBookingActivatorPort;
let passengerId: string;

async function givenRobotaxi(id: string, degrees: number): Promise<void> {
  await persistence.create('robotaxi', {
    id,
    state: 'AVAILABLE',
    lat: DUOMO.lat + degrees,
    lon: DUOMO.lon,
    zoneId: 'duomo',
  });
}

const draft = () => ({ passengerId, pickup: DUOMO, destination: CENTRALE });

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
  persistence = harness.persistence;
  rides = harness.rides;
  advanceBooking = harness.advanceBooking;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  await persistence.create('zone', { id: 'duomo', name: 'Duomo / Centro', ...DUOMO });

  const registered = await harness.auth.register({
    email: 'giulia.rossi@example.com',
    password: 'password-di-prova',
    name: 'Giulia',
    surname: 'Rossi',
    phoneNumber: null,
    role: 'PASSENGER',
  });
  passengerId = registered.user.id;
});

describe('[R3][R4][G2][G3] Corse immediate e prenotazioni sulla stessa timeline', () => {
  it('una corsa immediata non prende il veicolo riservato per una prenotazione imminente', async () => {
    await givenRobotaxi('RT-01', 0.01);
    await givenRobotaxi('RT-02', 0.05);

    // La prenotazione riserva RT-01 — il più vicino — a partire da `orario − anticipo`.
    const pickupAt = new Date(NOW.getTime() + 20 * 60_000);
    const booked = await rides.submitAdvance({ ...draft(), scheduledPickup: pickupAt });
    expect(booked.accepted && booked.robotaxiId).toBe('RT-01');

    // Adesso arriva una corsa immediata. RT-01 è ancora `AVAILABLE` — la prenotazione non lo
    // assegna — quindi è candidato: a escluderlo è la **finestra**, non lo stato. Se la corsa
    // immediata glielo portasse via, all'attivazione la prenotazione andrebbe ri-allocata o
    // rifiutata, che è ciò che la timeline condivisa esiste per evitare.
    const immediate = await rides.submitImmediate(draft());

    expect(immediate.accepted && immediate.robotaxiId).toBe('RT-02');
  });

  it('ma lo prende se la corsa finisce prima che la finestra prenotata cominci', async () => {
    await givenRobotaxi('RT-01', 0.01);

    // La prenotazione è per fra otto ore: la sua finestra comincia molto dopo la fine della corsa
    // immediata di adesso. Un intervallo di riserva **limitato** (decisione D8) è ciò che permette
    // al veicolo di fare entrambe le cose; con un estremo superiore aperto la seconda richiesta
    // qui sotto sarebbe rifiutata.
    const booked = await rides.submitAdvance({
      ...draft(),
      scheduledPickup: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
    });
    const immediate = await rides.submitImmediate(draft());

    expect(booked.accepted && booked.robotaxiId).toBe('RT-01');
    expect(immediate.accepted && immediate.robotaxiId).toBe('RT-01');

    // Due riserve dello stesso veicolo, non sovrapposte: è esattamente ciò che il vincolo di
    // esclusione ammette e che una riserva illimitata renderebbe impossibile.
    const reservations = await persistence.find('robotaxi_reservation', {
      where: { robotaxiId: 'RT-01' },
    });
    expect(reservations).toHaveLength(2);
  });

  it('una prenotazione non si perde se il suo veicolo è impegnato all attivazione', async () => {
    await givenRobotaxi('RT-01', 0.01);
    await givenRobotaxi('RT-02', 0.05);

    // Prenotazione fra quattro ore: riserva RT-01, il più vicino.
    const pickupAt = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);
    const booked = await rides.submitAdvance({ ...draft(), scheduledPickup: pickupAt });
    expect(booked.accepted && booked.robotaxiId).toBe('RT-01');

    // Una corsa immediata di adesso prende **lo stesso** RT-01, ed è corretto: la sua finestra
    // finisce molto prima di quella prenotata, e un veicolo tenuto fermo quattro ore in attesa di
    // una prenotazione sarebbe esattamente lo spreco che l'intervallo limitato di D8 evita.
    const immediate = await rides.submitImmediate(draft());
    expect(immediate.accepted && immediate.robotaxiId).toBe('RT-01');

    // All'orario dell'attivazione quella corsa è ancora in carico — in questa milestone nessuno
    // porta un veicolo fino a `completeRide()`: lo farà il simulatore di M7 — quindi RT-01 non è
    // fra i candidati. La prenotazione **non si perde**: viene ri-allocata, che è la ragione per
    // cui l'attivazione rivalida invece di fidarsi della riserva (decisione D9).
    harness.clock.setNow(activationDueAt(pickupAt));
    const report = await advanceBooking.runOnce();

    // `runOnce()` senza argomento legge `ClockPort`: è la forma con cui lo scheduler lo chiama in
    // produzione, e il tempo resta comunque sotto il controllo del test (CLAUDE.md Regola 3).
    expect(report.ranAt).toEqual(activationDueAt(pickupAt));
    expect(report.activations[0]).toMatchObject({
      rideRequestId: booked.request.id,
      outcome: 'REALLOCATED',
      robotaxiId: 'RT-02',
    });

    const [request] = await persistence.find('ride_request', { where: { id: booked.request.id } });
    expect(request).toMatchObject({ status: 'ACCEPTED', assignedRobotaxiId: 'RT-02' });
  });

  it('l annullamento di una corsa immediata restituisce il veicolo alla prenotazione successiva', async () => {
    await givenRobotaxi('RT-01', 0.01);

    // Un solo veicolo: la corsa immediata lo impegna, e una prenotazione nella stessa finestra è
    // rifiutata.
    const immediate = await rides.submitImmediate(draft());
    const pickupAt = new Date(NOW.getTime() + 20 * 60_000);
    const refused = await rides.submitAdvance({ ...draft(), scheduledPickup: pickupAt });
    expect(refused.accepted).toBe(false);

    await rides.cancel(immediate.request.id, passengerId);
    const accepted = await rides.submitAdvance({ ...draft(), scheduledPickup: pickupAt });

    // R14: la finestra rilasciata torna prenotabile, e il veicolo è tornato `AVAILABLE`.
    expect(accepted.accepted && accepted.robotaxiId).toBe('RT-01');
  });
});
