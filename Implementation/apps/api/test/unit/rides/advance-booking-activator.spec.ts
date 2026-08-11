import { composeRides, vehicleAt, type RidesHarness } from '../../support/rides';

/**
 * L'attivazione delle prenotazioni anticipate (M4; DD §2.4, decisione D9).
 *
 * Tutto qui dipende dal **tempo**, ed è la ragione per cui `runOnce(now)` è pubblico e l'orologio è
 * finto: senza controllo del tempo questi test sarebbero instabili, e un test instabile porta a
 * modificare codice sano inseguendo fallimenti che non esistono (CLAUDE.md Regola 3).
 */

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };
const NOW = new Date('2026-05-04T09:00:00.000Z');
const PICKUP_AT = new Date('2026-05-04T11:00:00.000Z');
/** L'anticipo di default è di 15 minuti: l'attivazione è dovuta alle 10:45. */
const DUE_AT = new Date('2026-05-04T10:45:00.000Z');
const PASSENGER = 'passenger-1';

const north = (id: string, degrees: number) =>
  vehicleAt(id, { lat: DUOMO.lat + degrees, lon: DUOMO.lon });

const draft = {
  passengerId: PASSENGER,
  pickup: DUOMO,
  destination: CENTRALE,
  scheduledPickup: PICKUP_AT,
};

let harness: RidesHarness;

afterEach(async () => {
  await harness?.close();
});

describe('[R4][G3] Advance booking activation', () => {
  it('prima dell istante di attivazione non attiva niente', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    await harness.rides.submitAdvance(draft);

    const report = await harness.advanceBooking.runOnce(new Date(DUE_AT.getTime() - 60_000));

    expect(report.activations).toEqual([]);
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('all istante dovuto porta il veicolo riservato ad assigned', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const booked = await harness.rides.submitAdvance(draft);

    const report = await harness.advanceBooking.runOnce(DUE_AT);

    expect(report.ranAt).toEqual(DUE_AT);
    expect(report.activations).toEqual([
      {
        bookingId: expect.any(String) as unknown as string,
        rideRequestId: booked.request.id,
        outcome: 'ACTIVATED',
        robotaxiId: 'RT-01',
      },
    ]);
    expect(harness.fleet.stateOf('RT-01')).toBe('ASSIGNED');

    const [request] = harness.persistence.rowsOf('ride_request');
    expect(request?.assignedRobotaxiId).toBe('RT-01');
    const [booking] = harness.persistence.rowsOf('booking');
    expect(booking?.activatedAt).toEqual(DUE_AT);
  });

  it('una prenotazione già attivata non viene ripresa', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    await harness.rides.submitAdvance(draft);

    await harness.advanceBooking.runOnce(DUE_AT);
    // Lo scheduler passa ogni minuto: senza idempotenza, l'esecuzione successiva proverebbe ad
    // assegnare un veicolo già assegnato e la corsa risulterebbe ri-allocata senza motivo.
    const second = await harness.advanceBooking.runOnce(new Date(DUE_AT.getTime() + 60_000));

    expect(second.activations).toEqual([]);
    expect(harness.fleet.assignments).toHaveLength(1);
  });

  it('un veicolo in rebalancing è ancora idoneo: la prenotazione lo interrompe', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    await harness.rides.submitAdvance(draft);
    // Decisione D32: «ancora idoneo» significa «fra i candidati», e un veicolo che si sta
    // riposizionando lo è — la transizione 10 esiste proprio per dirottarlo su una corsa.
    harness.fleet.setState('RT-01', 'REBALANCING');

    const report = await harness.advanceBooking.runOnce(DUE_AT);

    expect(report.activations[0]?.outcome).toBe('ACTIVATED');
    expect(harness.fleet.stateOf('RT-01')).toBe('ASSIGNED');
  });

  it('se il veicolo riservato è in manutenzione, ri-alloca su un altro', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });
    const booked = await harness.rides.submitAdvance(draft);
    expect(booked.accepted && booked.robotaxiId).toBe('RT-01');

    // Fra la prenotazione e l'orario, il veicolo riservato finisce in officina. È il caso per cui
    // l'attivazione **rivalida** invece di fidarsi (DD §2.4).
    harness.fleet.setState('RT-01', 'MAINTENANCE');
    const report = await harness.advanceBooking.runOnce(DUE_AT);

    expect(report.activations[0]).toMatchObject({ outcome: 'REALLOCATED', robotaxiId: 'RT-02' });
    expect(harness.fleet.stateOf('RT-02')).toBe('ASSIGNED');

    const [request] = harness.persistence.rowsOf('ride_request');
    expect(request?.status).toBe('ACCEPTED');
    expect(request?.assignedRobotaxiId).toBe('RT-02');
  });

  it('e la riserva del veicolo non più idoneo viene rilasciata', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });
    await harness.rides.submitAdvance(draft);
    harness.fleet.setState('RT-01', 'MAINTENANCE');

    await harness.advanceBooking.runOnce(DUE_AT);

    const reservations = harness.persistence.rowsOf('robotaxi_reservation');
    expect(reservations).toHaveLength(2);
    // Tenerla bloccherebbe la finestra di un veicolo che questa corsa non avrà comunque.
    expect(reservations.find((row) => row.robotaxiId === 'RT-01')?.releasedAt).toEqual(DUE_AT);
    expect(reservations.find((row) => row.robotaxiId === 'RT-02')?.releasedAt).toBeNull();

    // La prenotazione punta al veicolo e alla riserva nuovi.
    const [booking] = harness.persistence.rowsOf('booking');
    expect(booking?.robotaxiId).toBe('RT-02');
    expect(booking?.activatedAt).toEqual(DUE_AT);
  });

  it('se nessun altro veicolo è idoneo, la richiesta è rifiutata', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const booked = await harness.rides.submitAdvance(draft);
    harness.fleet.setState('RT-01', 'MAINTENANCE');

    const report = await harness.advanceBooking.runOnce(DUE_AT);

    expect(report.activations[0]).toMatchObject({
      rideRequestId: booked.request.id,
      outcome: 'REJECTED',
      robotaxiId: null,
    });
    const [request] = harness.persistence.rowsOf('ride_request');
    expect(request?.status).toBe('REJECTED');
  });

  it('una richiesta rifiutata non viene ripresa dall esecuzione successiva', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    await harness.rides.submitAdvance(draft);
    harness.fleet.setState('RT-01', 'MAINTENANCE');
    await harness.advanceBooking.runOnce(DUE_AT);

    // La prenotazione resta con `activatedAt` nullo, ma la richiesta non è più `ACCEPTED`: è lo
    // stato della richiesta a impedire che la si riprenda ogni minuto per sempre.
    harness.fleet.setState('RT-01', 'AVAILABLE');
    const second = await harness.advanceBooking.runOnce(new Date(DUE_AT.getTime() + 60_000));

    expect(second.activations).toEqual([]);
  });

  it('una prenotazione annullata non è un esito dell attivazione', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const booked = await harness.rides.submitAdvance(draft);
    await harness.rides.cancel(booked.request.id, PASSENGER);

    const report = await harness.advanceBooking.runOnce(DUE_AT);

    // Non c'è niente da attivare, e non è un rifiuto: la corsa non ci sarà perché il passeggero
    // non la vuole più (R14).
    expect(report.activations).toEqual([]);
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('più prenotazioni dovute si attivano nell ordine della loro scadenza', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });

    const later = await harness.rides.submitAdvance(draft);
    const earlier = await harness.rides.submitAdvance({
      ...draft,
      scheduledPickup: new Date(PICKUP_AT.getTime() - 30 * 60_000),
    });

    const report = await harness.advanceBooking.runOnce(new Date(PICKUP_AT.getTime()));

    // L'ordinamento è totale — prima le più urgenti — perché quando due prenotazioni si contendono
    // l'ultimo veicolo l'esito non deve dipendere dall'ordine con cui il database ha risposto.
    expect(report.activations.map((activation) => activation.rideRequestId)).toEqual([
      earlier.request.id,
      later.request.id,
    ]);
  });
});
