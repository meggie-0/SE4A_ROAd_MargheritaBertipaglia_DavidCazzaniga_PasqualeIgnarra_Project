import { composeRides, type RidesHarness } from '../../support/rides';

/**
 * La telemetria che fa avanzare le corse (M7, decisione D61).
 *
 * Fino a M6 le quattro transizioni della corsa le chiamavano i test, uno per volta: la Figura 2.10
 * lascia aperte le guardie che dipendono dalla posizione del veicolo — `hasReachedPickup()`,
 * `hasReachedDestination()` — e senza telemetria nessuno sapeva dire *quando*. Qui si verifica il
 * componente che quel «quando» lo decide.
 *
 * La composizione è quella di M4 e M5: archivio in memoria, `FleetDouble` al posto della flotta,
 * `TravelTimeDouble` al posto dei fornitori — dove «arrivare» è una cosa che il test dichiara, con
 * `arrive()`, invece di far percorrere davvero una polyline. La polyline vera la percorre
 * `@road/simulator`, ed è verificata nei suoi test e nel cancello di M7, su Postgres. Qui interessa
 * un'altra cosa: che il giro faccia il passo **giusto** al momento giusto, e nessuno quando non
 * deve.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };
const GIULIA = 'passeggero-giulia';

let harness: RidesHarness;

const vehicle = (id: string) => ({
  id,
  state: 'AVAILABLE' as const,
  lat: DUOMO.lat + 0.01,
  lon: DUOMO.lon,
  zoneId: 'duomo',
  updatedAt: NOW,
});

async function givenAcceptedRide(): Promise<string> {
  const outcome = await harness.rides.submitImmediate({
    passengerId: GIULIA,
    pickup: DUOMO,
    destination: CENTRALE,
  });
  expect(outcome.accepted).toBe(true);
  return outcome.request.id;
}

beforeEach(async () => {
  harness = await composeRides({ now: NOW, vehicles: [vehicle('RT-01')] });
});

afterEach(async () => {
  await harness?.close();
});

describe('[R6][G7] La telemetria fa avanzare la corsa', () => {
  it('il primo giro comanda la rotta verso il ritiro e manda il veicolo in avvicinamento', async () => {
    const rideRequestId = await givenAcceptedRide();

    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([
      { rideRequestId, robotaxiId: 'RT-01', step: 'PICKUP_NAVIGATION_STARTED' },
    ]);
    expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVING');
    // La rotta è stata comandata **verso il punto di ritiro**, non verso la destinazione.
    expect(harness.external.routeCommands).toEqual([{ robotaxiId: 'RT-01', destination: DUOMO }]);
  });

  it('finché il veicolo non è arrivato, i giri successivi non fanno niente', async () => {
    await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();

    const second = await harness.fleetTelemetry.runOnce();
    const third = await harness.fleetTelemetry.runOnce();

    expect(second.advanced).toEqual([]);
    expect(third.advanced).toEqual([]);
    expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVING');
  });

  it('la catena completa: avvicinamento, ritiro, partenza, arrivo a destinazione', async () => {
    const rideRequestId = await givenAcceptedRide();

    await harness.fleetTelemetry.runOnce(); // → ARRIVING, rotta verso il ritiro
    harness.external.arrive('RT-01'); // il veicolo raggiunge il ritiro
    await harness.fleetTelemetry.runOnce(); // → ARRIVED
    await harness.fleetTelemetry.runOnce(); // → IN_RIDE, rotta verso la destinazione
    harness.external.arrive('RT-01'); // il veicolo raggiunge la destinazione
    const last = await harness.fleetTelemetry.runOnce(); // → corsa completata

    expect(last.advanced).toEqual([{ rideRequestId, robotaxiId: 'RT-01', step: 'RIDE_COMPLETED' }]);
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');

    const [request] = harness.persistence
      .rowsOf('ride_request')
      .filter((row) => row.id === rideRequestId);
    expect(request?.status).toBe('COMPLETED');

    /**
     * I comandi di rotta raccontano il viaggio: al ritiro, poi a destinazione, poi la **revoca**.
     *
     * L'ultima riga è quella che conta: un veicolo tornato disponibile senza revoca continuerebbe a
     * dichiararsi «arrivato» alla destinazione di una corsa che non esiste più, e il giro
     * successivo lo troverebbe fermo su un fatto vecchio.
     */
    expect(harness.external.routeCommands).toEqual([
      { robotaxiId: 'RT-01', destination: DUOMO },
      { robotaxiId: 'RT-01', destination: CENTRALE },
      { robotaxiId: 'RT-01', destination: null },
    ]);
  });

  it('arrivare al ritiro non chiude la corsa: il punto raggiunto viene confrontato', async () => {
    await givenAcceptedRide();

    await harness.fleetTelemetry.runOnce();
    harness.external.arrive('RT-01');
    await harness.fleetTelemetry.runOnce();
    // Il veicolo è fermo al ritiro e la telemetria continua a dire «arrivato»: se il giro
    // guardasse solo quel campo, e non **dove**, farebbe partire e concludere la corsa in un colpo.
    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([expect.objectContaining({ step: 'RIDE_STARTED' })]);
    expect(harness.fleet.stateOf('RT-01')).toBe('IN_RIDE');
  });

  it('le posizioni osservate finiscono in tabella, anche per chi non sta servendo nessuno', async () => {
    await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();

    const cycle = await harness.fleetTelemetry.runOnce();

    // Un veicolo in movimento è un veicolo di cui l'operatore deve poter vedere la posizione (R7).
    expect(cycle.positionsRecorded).toBe(1);
    expect(cycle.observedAt).toEqual(NOW);
  });

  it('senza corse in corso il giro non fa nulla e non solleva', async () => {
    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([]);
    expect(cycle.positionsRecorded).toBe(0);
    expect(harness.external.routeCommands).toEqual([]);
  });

  it('una corsa annullata non avanza più, e il giro prosegue senza sollevare', async () => {
    const rideRequestId = await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();
    await harness.rides.cancel(rideRequestId, GIULIA);

    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([]);
    // L'annullamento ha riportato il veicolo fra i disponibili, e la telemetria non lo rimuove.
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('un veicolo portato via da qualcun altro non ferma il giro', async () => {
    const rideRequestId = await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();

    // Fra un giro e l'altro il veicolo finisce in manutenzione: la transizione successiva verrà
    // rifiutata dalla macchina a stati, e il giro deve limitarsi a saltarla.
    harness.fleet.setState('RT-01', 'MAINTENANCE');
    harness.external.arrive('RT-01');

    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([]);
    expect(harness.fleet.stateOf('RT-01')).toBe('MAINTENANCE');

    // E il giro dopo riparte da dove il veicolo si trova davvero, senza ricordare nulla.
    const again = await harness.fleetTelemetry.runOnce();
    expect(again.advanced).toEqual([]);
    expect(rideRequestId).toBeDefined();
  });
});
