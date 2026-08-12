import { recordOperator, recordPassenger } from '../../support/notifications';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * L'Observer sulla catena vera (M5, R6, G7; DD §2.3.3).
 *
 * Qui i soggetti sono quelli veri: il `Robotaxi` che `FleetMonitor` costruisce a ogni transizione e
 * la `Ride` che `rides` fa avanzare, entrambi con il `NotificationManager` registrato sopra come
 * unico observer. È il livello in cui si vede la sola cosa che i test unitari non possono mostrare —
 * che le due metà della progressione arrivano **insieme e nell'ordine giusto** — e in cui lo
 * storico finisce su una tabella vera invece che in una mappa.
 *
 * **Serve Docker in esecuzione.**
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const HOOK_TIMEOUT_MS = 180_000;

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };

const PASSENGER = {
  email: 'giulia.rossi@example.com',
  password: 'password-di-prova',
  name: 'Giulia',
  surname: 'Rossi',
  phoneNumber: null,
  role: 'PASSENGER' as const,
};

let harness: ApiHarness;
let passengerId: string;

async function givenRobotaxi(id: string, degrees: number): Promise<void> {
  await harness.persistence.create('robotaxi', {
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
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
  await harness.persistence.create('zone', { id: 'duomo', name: 'Duomo / Centro', ...DUOMO });
  passengerId = (await harness.auth.register(PASSENGER)).user.id;
});

describe('[R6][G7] Gli eventi di dominio raggiungono chi li aspetta', () => {
  it('il passeggero vede il veicolo e la corsa avanzare insieme', async () => {
    await givenRobotaxi('RT-01', 0.01);
    const giulia = recordPassenger(harness.notificationSessions, passengerId);

    const outcome = await harness.rides.submitImmediate(draft());
    expect(outcome.accepted).toBe(true);

    await harness.rideLifecycle.startPickupNavigation(outcome.request.id);
    await harness.rideLifecycle.pickupReached(outcome.request.id);
    await harness.rideLifecycle.startRide(outcome.request.id);

    // La sequenza che MILESTONES.md §M5 chiede, emessa dal `Robotaxi` vero a ogni transizione
    // scritta in colonna.
    expect(giulia.robotaxiStates()).toEqual(['ASSIGNED', 'ARRIVING', 'ARRIVED', 'IN_RIDE']);
    // E l'altra metà, dalla `Ride`: sono due soggetti distinti sullo stesso observer.
    expect(giulia.rideStatuses()).toEqual(['SCHEDULED', 'WAITING_FOR_PICKUP', 'IN_PROGRESS']);
  });

  it("l'operatore vede la flotta, il passeggero solo la propria corsa", async () => {
    await givenRobotaxi('RT-01', 0.01);
    await givenRobotaxi('RT-02', 0.05);

    const altro = await harness.auth.register({ ...PASSENGER, email: 'marco@example.com' });
    const giulia = recordPassenger(harness.notificationSessions, passengerId);
    const marco = recordPassenger(harness.notificationSessions, altro.user.id);
    const operatore = recordOperator(harness.notificationSessions);

    const sua = await harness.rides.submitImmediate(draft());
    await harness.rides.submitImmediate({ ...draft(), passengerId: altro.user.id });
    await harness.rideLifecycle.startPickupNavigation(sua.request.id);

    // Giulia vede solo il proprio veicolo; Marco solo il suo. Nessuna delle due liste contiene
    // l'identificatore dell'altro veicolo, ed è questo il criterio: «nessun evento di corse altrui».
    expect(giulia.received.map((one) => one.robotaxiId)).toEqual(['RT-01', 'RT-01', 'RT-01']);
    expect(marco.received.map((one) => one.robotaxiId)).toEqual(['RT-02', 'RT-02']);
    // L'operatore vede i movimenti di entrambi i veicoli, e nessuno stato di corsa.
    expect(operatore.received.map((one) => one.robotaxiId)).toEqual(['RT-01', 'RT-02', 'RT-01']);
    expect(operatore.received.every((one) => one.rideStatus === null)).toBe(true);
  });

  it('lo storico finisce in tabella, con il destinatario giusto', async () => {
    await givenRobotaxi('RT-01', 0.01);
    const outcome = await harness.rides.submitImmediate(draft());
    await harness.rideLifecycle.startPickupNavigation(outcome.request.id);

    const written = await harness.persistence.find('notification', {
      orderBy: [{ field: 'createdAt' }, { field: 'type' }],
    });

    // Nessuno era connesso, e la riga c'è comunque: è ciò che permette a un client che riapre
    // l'app di ritrovare quello che si è perso.
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(written.every((row) => row.recipientId === passengerId)).toBe(true);
    expect(written.map((row) => row.type)).toContain('VEHICLE_ASSIGNED');
    expect(written.map((row) => row.type)).toContain('VEHICLE_ARRIVING');
  });

  it('un evento di flotta che nessuna corsa riguarda non lascia una riga di notifica', async () => {
    await givenRobotaxi('RT-01', 0.01);
    const operatore = recordOperator(harness.notificationSessions);

    await harness.maintenance.requestMaintenance('RT-01', 'freni');

    // Arriva alla dashboard...
    expect(operatore.robotaxiStates()).toEqual(['MAINTENANCE']);
    expect(operatore.received[0]?.type).toBeNull();
    // ...ma la `Notification` del RASD §2.2.3 è indirizzata a un passeggero, e qui non ce n'è uno.
    expect(await harness.countRows('notification')).toBe(0);
  });
});

describe('[R6][G7] La corsa completata chiude tutto ciò che aveva aperto', () => {
  it('notifica il completamento e accorcia la riserva sull istante effettivo', async () => {
    await givenRobotaxi('RT-01', 0.01);
    const giulia = recordPassenger(harness.notificationSessions, passengerId);

    const outcome = await harness.rides.submitImmediate(draft());
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;

    // La finestra iniziale è una **stima**: ETA più durata più buffer (decisione D8).
    const stimata = outcome.reservation.period.end;
    expect(stimata.getTime()).toBeGreaterThan(NOW.getTime());

    await harness.rideLifecycle.startPickupNavigation(outcome.request.id);
    await harness.rideLifecycle.pickupReached(outcome.request.id);
    await harness.rideLifecycle.startRide(outcome.request.id);

    // La corsa finisce prima di quanto la stima prevedesse.
    const finita = new Date(NOW.getTime() + 5 * 60_000);
    harness.clock.setNow(finita);
    await harness.rideLifecycle.completeRide(outcome.request.id);

    // «Ride completion», che R6 nomina, arriva dalla corsa: dopo la deduplica di D42 ne è l'unica
    // sorgente, quindi è qui che si vede se quella metà del canale funziona davvero.
    expect(giulia.rideStatuses()).toEqual([
      'SCHEDULED',
      'WAITING_FOR_PICKUP',
      'IN_PROGRESS',
      'COMPLETED',
    ]);
    expect(giulia.robotaxiStates()).toEqual(['ASSIGNED', 'ARRIVING', 'ARRIVED', 'IN_RIDE']);

    /**
     * La riserva si è **accorciata** sull'istante effettivo (decisione D8), non rilasciata.
     *
     * Verificato su Postgres e non su un doppio: `period` è un `tstzrange` con un `transformer`
     * dedicato, e vive sotto il vincolo di esclusione `no_overlapping_reservations`. Un
     * accorciamento che il doppio accetta e il database rifiuta sarebbe un difetto invisibile
     * ovunque tranne che qui.
     */
    const [reservation] = await harness.persistence.find('robotaxi_reservation', {
      where: { rideRequestId: outcome.request.id },
    });
    expect(reservation?.period.end).toEqual(finita);
    expect(reservation?.period.end.getTime()).toBeLessThan(stimata.getTime());
    // Onorata, non annullata: il tempo già consumato resta occupato (R14 è un'altra cosa).
    expect(reservation?.releasedAt).toBeNull();

    // E il tempo che avanza torna prenotabile: è l'effetto osservabile dell'accorciamento.
    expect(
      await harness.persistence.filterAvailable(['RT-01'], {
        start: new Date(finita.getTime() + 60_000),
        end: stimata,
      }),
    ).toEqual(['RT-01']);
  });
});

describe('[R6][NFR5] Si notifica ciò che è stato scritto, non ciò che si stava per fare', () => {
  it('una transizione illegale non produce nessuna notifica', async () => {
    await givenRobotaxi('RT-01', 0.01);
    const giulia = recordPassenger(harness.notificationSessions, passengerId);
    const outcome = await harness.rides.submitImmediate(draft());
    giulia.received.length = 0;

    // Da `ASSIGNED` la Figura 2.10 non ammette `startRide()`.
    await expect(harness.rideLifecycle.startRide(outcome.request.id)).rejects.toThrow();

    expect(giulia.received).toEqual([]);
    // E il database non è stato toccato: lo stato è ancora quello di prima (NFR5).
    const [row] = await harness.query<{ state: string }>(
      `SELECT "state" FROM "robotaxi" WHERE "id" = 'RT-01'`,
    );
    expect(row?.state).toBe('ASSIGNED');
  });
});

describe('[R6][R4] Una prenotazione notifica quando diventa un assegnazione', () => {
  it('la corsa nasce senza veicolo e lo riceve all attivazione', async () => {
    await givenRobotaxi('RT-01', 0.01);
    const giulia = recordPassenger(harness.notificationSessions, passengerId);

    const pickupAt = new Date(NOW.getTime() + 7_200_000);
    const booked = await harness.rides.submitAdvance({ ...draft(), scheduledPickup: pickupAt });
    expect(booked.accepted).toBe(true);

    // Alla prenotazione il veicolo è **riservato**, non assegnato (decisione D9): la corsa esiste
    // ed è `SCHEDULED`, e nessun veicolo ha ancora niente da raccontare.
    expect(giulia.rideStatuses()).toEqual(['SCHEDULED']);
    expect(giulia.robotaxiStates()).toEqual([]);

    const [ride] = await harness.persistence.find('ride', {
      where: { rideRequestId: booked.request.id },
    });
    expect(ride?.robotaxiId).toBeNull();

    await harness.advanceBooking.runOnce(new Date(pickupAt.getTime() - 15 * 60_000));

    // Ora sì: il veicolo passa ad `ASSIGNED` ed è lui a notificarlo.
    expect(giulia.robotaxiStates()).toEqual(['ASSIGNED']);
    const [activated] = await harness.persistence.find('ride', {
      where: { rideRequestId: booked.request.id },
    });
    expect(activated?.robotaxiId).toBe('RT-01');
  });
});
