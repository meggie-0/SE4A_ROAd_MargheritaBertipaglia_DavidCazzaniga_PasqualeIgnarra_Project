import { IllegalTransitionError } from '../../../src/fleet/robotaxi.port';
import { RideNotInProgressError } from '../../../src/rides/ride-lifecycle.port';
import { recordOperator, recordPassenger } from '../../support/notifications';
import { composeRides, type RidesHarness } from '../../support/rides';

/**
 * L'avanzamento di una corsa assegnata, e la progressione che ne arriva al passeggero (M5, R6, G7).
 *
 * Qui gira l'intera catena di `rides` — `RideRequestManager`, `RideLifecycle`, `RideJournal` e il
 * `NotificationManager` vero — con archivio in memoria al posto del database e `FleetDouble` al
 * posto della flotta. È il livello giusto per due domande che il database non renderebbe più
 * chiare: **in che ordine** si muovono veicolo e corsa, e che cosa succede quando un passo arriva
 * fuori tempo. La stessa progressione su Postgres vero, con la macchina a stati vera, è nel
 * cancello.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };
const GIULIA = 'passeggero-giulia';

let harness: RidesHarness;

const vehicle = (id: string, latOffset: number) => ({
  id,
  state: 'AVAILABLE' as const,
  lat: DUOMO.lat + latOffset,
  lon: DUOMO.lon,
  zoneId: 'duomo',
  updatedAt: NOW,
});

/** Una corsa immediata accettata, con il veicolo già assegnato. */
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
  harness = await composeRides({ now: NOW, vehicles: [vehicle('RT-01', 0.01)] });
});

afterEach(async () => {
  await harness?.close();
});

describe('[R6][G7] La corsa avanza e il passeggero la vede avanzare', () => {
  it('assigned → arriving → arrived → in_ride, e poi la corsa si chiude', async () => {
    const giulia = recordPassenger(harness.notificationSessions, GIULIA);
    const rideRequestId = await givenAcceptedRide();

    await harness.rideLifecycle.startPickupNavigation(rideRequestId);
    await harness.rideLifecycle.pickupReached(rideRequestId);
    await harness.rideLifecycle.startRide(rideRequestId);
    await harness.rideLifecycle.completeRide(rideRequestId);

    /**
     * La progressione della **corsa** (RASD §2.2.3), che è una delle due letture del viaggio.
     *
     * L'altra — `ASSIGNED → ARRIVING → ARRIVED → IN_RIDE` sul veicolo — **non si vede qui**, ed è
     * corretto: a emetterla è `FleetMonitor` registrando il `NotificationManager` su ogni
     * `Robotaxi`, e in questa composizione `FleetMonitorPort` è sostituito da un doppio. Farla
     * emettere anche al doppio significherebbe scrivere due volte la stessa notifica e vedere il
     * test passare sulla copia. Quella metà è verificata dove il `FleetMonitor` è quello vero: nei
     * test di integrazione e nel cancello di M5, su Postgres.
     *
     * `SCHEDULED` compare all'apertura; la partenza verso il ritiro non cambia lo stato della corsa,
     * ed è voluto — per il passeggero il patto non è cambiato, è cambiato dove si trova il veicolo.
     */
    expect(giulia.rideStatuses()).toEqual([
      'SCHEDULED',
      'WAITING_FOR_PICKUP',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
    // E nessuna notifica di veicolo: in questa composizione il soggetto `Robotaxi` non c'è.
    expect(giulia.robotaxiStates()).toEqual([]);
  });

  it('la corsa completata chiude la richiesta e libera il veicolo', async () => {
    const rideRequestId = await givenAcceptedRide();

    await harness.rideLifecycle.startPickupNavigation(rideRequestId);
    await harness.rideLifecycle.pickupReached(rideRequestId);
    await harness.rideLifecycle.startRide(rideRequestId);
    const progress = await harness.rideLifecycle.completeRide(rideRequestId);

    expect(progress.request.status).toBe('COMPLETED');
    expect(progress.ride?.status).toBe('COMPLETED');
    expect(progress.ride?.startedAt).toEqual(NOW);
    expect(progress.ride?.endedAt).toEqual(NOW);
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it("l'operatore non riceve lo stato di avanzamento della corsa di un passeggero", async () => {
    const operatore = recordOperator(harness.notificationSessions);
    const rideRequestId = await givenAcceptedRide();

    await harness.rideLifecycle.startPickupNavigation(rideRequestId);
    await harness.rideLifecycle.pickupReached(rideRequestId);

    // Gli eventi di corsa sono del passeggero. La dashboard sorveglia la **flotta** (R7, G8), e
    // quella progressione la vede dal lato del veicolo — verificato nel cancello, dove il
    // `FleetMonitor` vero emette davvero.
    expect(operatore.received).toEqual([]);
  });
});

describe('[R6][NFR5] Un passo fuori tempo non muove nulla', () => {
  it('saltare la partenza verso il ritiro è rifiutato dalla macchina a stati', async () => {
    const giulia = recordPassenger(harness.notificationSessions, GIULIA);
    const rideRequestId = await givenAcceptedRide();
    giulia.received.length = 0;

    // Da `ASSIGNED` la Figura 2.10 non ammette `pickupReached()`: ci si passa da `ARRIVING`.
    await expect(harness.rideLifecycle.pickupReached(rideRequestId)).rejects.toBeInstanceOf(
      IllegalTransitionError,
    );

    // **Il veicolo prima, la corsa poi**: il rifiuto arriva prima che la corsa venga toccata, e
    // prima che parta una notifica. Nell'ordine opposto il passeggero avrebbe saputo di un arrivo
    // mai avvenuto, e una notifica non si disfa.
    expect(harness.fleet.stateOf('RT-01')).toBe('ASSIGNED');
    expect(giulia.received).toEqual([]);
    expect(harness.persistence.rowsOf('ride')[0]?.status).toBe('SCHEDULED');
  });

  it('una richiesta annullata non ha più una corsa da far avanzare', async () => {
    const rideRequestId = await givenAcceptedRide();
    await harness.rides.cancel(rideRequestId, GIULIA);

    await expect(harness.rideLifecycle.startPickupNavigation(rideRequestId)).rejects.toBeInstanceOf(
      RideNotInProgressError,
    );
  });

  it('una richiesta che non esiste nemmeno', async () => {
    await expect(harness.rideLifecycle.startRide('richiesta-inventata')).rejects.toBeInstanceOf(
      RideNotInProgressError,
    );
  });
});

describe('[R14] Annullare chiude la corsa e lo dice al passeggero', () => {
  it("l'annullamento notifica anche quando nessun veicolo era stato assegnato", async () => {
    const giulia = recordPassenger(harness.notificationSessions, GIULIA);

    // Nessun veicolo idoneo: la richiesta nasce rifiutata e non genera una corsa (RASD §2.2.1).
    harness.fleet.setState('RT-01', 'MAINTENANCE');
    const rejected = await harness.rides.submitImmediate({
      passengerId: GIULIA,
      pickup: DUOMO,
      destination: CENTRALE,
    });
    expect(rejected.accepted).toBe(false);
    expect(harness.persistence.rowsOf('ride')).toHaveLength(0);
    expect(giulia.received).toEqual([]);

    // Una prenotazione anticipata invece la corsa ce l'ha, pur senza veicolo assegnato.
    harness.fleet.setState('RT-01', 'AVAILABLE');
    const booked = await harness.rides.submitAdvance({
      passengerId: GIULIA,
      pickup: DUOMO,
      destination: CENTRALE,
      scheduledPickup: new Date(NOW.getTime() + 7_200_000),
    });
    expect(booked.accepted).toBe(true);

    giulia.received.length = 0;
    await harness.rides.cancel(booked.request.id, GIULIA);

    // Il veicolo non si è mosso — era riservato, non assegnato — quindi non ha niente da
    // raccontare: la notifica arriva dalla corsa, che è l'altro soggetto dell'Observer.
    expect(giulia.rideStatuses()).toEqual(['CANCELLED']);
  });
});
