import {
  RecordNotFoundError,
  ReservationConflictError,
  advanceReservationWindow,
  immediateReservationWindow,
  type PersistencePort,
  type TimeWindow,
} from '../../../src/persistence/persistence.port';
import { startPersistence, type PersistenceHarness } from '../../support/postgres';

/**
 * Il `PersistenceManager` su un Postgres vero (HARNESS.md §1, passo 9).
 *
 * Tutto passa da `PersistencePort`: se questi test iniettassero il manager concreto smetterebbero
 * di dimostrare che il modulo è sostituibile, che è la proprietà per cui i confini esistono
 * (HARNESS.md §9).
 */

const PICKUP = { lat: 45.4642, lon: 9.19 };
const DESTINATION = { lat: 45.4781, lon: 9.227 };

/** L'orario a cui è fermo l'orologio finto dell'harness. */
const NOW = new Date('2026-05-04T09:00:00.000Z');

let harness: PersistenceHarness;
let persistence: PersistencePort;

/** Avviare un container Postgres a freddo non sta nei 5 secondi di default dei hook di Jest. */
const HOOK_TIMEOUT_MS = 180_000;

beforeAll(async () => {
  harness = await startPersistence(NOW.toISOString());
  persistence = harness.persistence;
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
});

/** Una zona e `count` robotaxi disponibili, con identificatori `RT-01`, `RT-02`, … */
async function givenFleet(count: number): Promise<string[]> {
  await persistence.create('zone', { id: 'duomo', name: 'Duomo / Centro', ...PICKUP });

  const ids: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    const id = `RT-${String(index).padStart(2, '0')}`;
    await persistence.create('robotaxi', {
      id,
      state: 'AVAILABLE',
      lat: PICKUP.lat,
      lon: PICKUP.lon,
      zoneId: 'duomo',
    });
    ids.push(id);
  }
  return ids;
}

/** Un passeggero con una richiesta di corsa in attesa; restituisce l'id della richiesta. */
async function givenRideRequest(email = 'anna@example.com'): Promise<string> {
  const passenger = await persistence.create('user', {
    email,
    passwordHash: 'non-una-password',
    name: 'Anna',
    surname: 'Rossi',
    phoneNumber: '+39 02 0000000',
    role: 'PASSENGER',
  });

  const request = await persistence.create('ride_request', {
    passengerId: passenger.id,
    kind: 'IMMEDIATE',
    status: 'PENDING',
    pickupLat: PICKUP.lat,
    pickupLon: PICKUP.lon,
    pickupAddress: 'Piazza del Duomo',
    destinationLat: DESTINATION.lat,
    destinationLon: DESTINATION.lon,
    destinationAddress: 'Piazza Leonardo da Vinci',
    assignedRobotaxiId: null,
  });

  return request.id;
}

describe('Persistence: scrittura e rilettura dei record', () => {
  it('riempie le date da ClockPort e non dall’orologio di sistema', async () => {
    harness.clock.setNow('2026-05-04T11:22:33.000Z');

    const zone = await persistence.create('zone', { id: 'navigli', name: 'Navigli', ...PICKUP });
    const robotaxi = await persistence.create('robotaxi', {
      id: 'RT-99',
      state: 'AVAILABLE',
      lat: PICKUP.lat,
      lon: PICKUP.lon,
      zoneId: zone.id,
    });

    expect(robotaxi.updatedAt.toISOString()).toBe('2026-05-04T11:22:33.000Z');
  });

  it('genera un identificatore per le tabelle che non hanno una chiave parlante', async () => {
    const requestId = await givenRideRequest();

    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('aggiorna un record e ne aggiorna la data di modifica', async () => {
    await givenFleet(1);
    harness.clock.setNow('2026-05-04T10:00:00.000Z');

    const updated = await persistence.update('robotaxi', 'RT-01', { state: 'MAINTENANCE' });

    expect(updated.state).toBe('MAINTENANCE');
    expect(updated.updatedAt.toISOString()).toBe('2026-05-04T10:00:00.000Z');
  });

  it('rifiuta un aggiornamento su un identificatore che non esiste', async () => {
    await expect(
      persistence.update('robotaxi', 'RT-inesistente', { state: 'AVAILABLE' }),
    ).rejects.toThrow(RecordNotFoundError);
  });

  it('parte con un solo record di system_mode, in NearestAvailable e modo Auto', async () => {
    // La riga singleton nasce con lo schema: il sistema deve saper rispondere "qual è la
    // strategia attiva?" anche su un database mai seminato (decisione D6). La lettura passa dalla
    // porta, come faranno `getActiveStrategy()` e `getMode()` in M6.
    const modes = await persistence.find('system_mode');

    expect(modes).toHaveLength(1);
    expect(modes[0]?.activeStrategy).toBe('NEAREST_AVAILABLE');
    expect(modes[0]?.mode).toBe('AUTO');
    expect(modes[0]?.lastTrafficLevel).toBeNull();
  });

  it('aggiorna la strategia attiva passando dalla porta', async () => {
    const updated = await persistence.update('system_mode', 'singleton', {
      activeStrategy: 'MINIMUM_ETA',
      mode: 'MANUAL',
      lastTrafficLevel: 'HIGH',
    });

    expect(updated.activeStrategy).toBe('MINIMUM_ETA');
    expect(updated.mode).toBe('MANUAL');
    expect(updated.lastTrafficLevel).toBe('HIGH');
  });
});

describe('[NFR4][G10] Timeline delle riserve: filterAvailable', () => {
  const window: TimeWindow = immediateReservationWindow(NOW, 5, 20);

  it('senza riserve restituisce tutti i candidati, in ordine crescente', async () => {
    await givenFleet(3);

    expect(await persistence.filterAvailable(['RT-03', 'RT-01', 'RT-02'], window)).toEqual([
      'RT-01',
      'RT-02',
      'RT-03',
    ]);
  });

  it('su un insieme vuoto di candidati non restituisce nulla', async () => {
    expect(await persistence.filterAvailable([], window)).toEqual([]);
  });

  it('esclude un veicolo la cui riserva si sovrappone alla finestra richiesta', async () => {
    await givenFleet(3);
    const requestId = await givenRideRequest();

    await persistence.reserve({ robotaxiId: 'RT-02', rideRequestId: requestId, window });

    expect(await persistence.filterAvailable(['RT-01', 'RT-02', 'RT-03'], window)).toEqual([
      'RT-01',
      'RT-03',
    ]);
  });

  it('non esclude un veicolo la cui riserva soltanto tocca la finestra', async () => {
    await givenFleet(1);
    const requestId = await givenRideRequest();

    const earlier: TimeWindow = { start: new Date('2026-05-04T08:00:00.000Z'), end: window.start };
    await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: requestId, window: earlier });

    // Gli intervalli sono semiaperti: `[…, 09:00)` e `[09:00, …)` non si sovrappongono, quindi un
    // veicolo può iniziare una corsa nell'istante in cui ne finisce un'altra.
    expect(await persistence.filterAvailable(['RT-01'], window)).toEqual(['RT-01']);
  });

  it('torna a considerare libero un veicolo quando la riserva viene chiusa in anticipo', async () => {
    await givenFleet(1);
    const requestId = await givenRideRequest();

    const long: TimeWindow = immediateReservationWindow(NOW, 5, 240);
    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: requestId,
      window: long,
    });
    if (!outcome.reserved) throw new Error('la prima riserva doveva riuscire');

    const late: TimeWindow = {
      start: new Date('2026-05-04T11:00:00.000Z'),
      end: new Date('2026-05-04T12:00:00.000Z'),
    };
    expect(await persistence.filterAvailable(['RT-01'], late)).toEqual([]);

    // Decisione D8: quando la corsa finisce, il limite superiore si chiude all'istante effettivo
    // e il tempo liberato torna disponibile.
    await persistence.update('robotaxi_reservation', outcome.reservation.id, {
      period: { start: long.start, end: new Date('2026-05-04T09:40:00.000Z') },
    });

    expect(await persistence.filterAvailable(['RT-01'], late)).toEqual(['RT-01']);
  });
});

describe('[NFR4][G10] Riserve senza sovrapposizioni', () => {
  const window: TimeWindow = immediateReservationWindow(NOW, 5, 20);

  it('scrive la riserva e restituisce la finestra così com’è stata chiesta', async () => {
    await givenFleet(1);
    const requestId = await givenRideRequest();

    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: requestId,
      window,
    });

    expect(outcome.reserved).toBe(true);
    if (!outcome.reserved) return;
    expect(outcome.reservation.robotaxiId).toBe('RT-01');
    expect(outcome.reservation.period.start.toISOString()).toBe(window.start.toISOString());
    expect(outcome.reservation.period.end.toISOString()).toBe(window.end.toISOString());
    expect(outcome.booking).toBeNull();
  });

  it('rifiuta una seconda riserva sovrapposta sullo stesso veicolo', async () => {
    await givenFleet(1);
    const first = await givenRideRequest('anna@example.com');
    const second = await givenRideRequest('bruno@example.com');

    await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: first, window });
    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: second,
      window: immediateReservationWindow(new Date('2026-05-04T09:10:00.000Z'), 5, 20),
    });

    expect(outcome).toEqual({ reserved: false, reason: 'OVERLAPPING_RESERVATION' });
    expect(await harness.countRows('robotaxi_reservation')).toBe(1);
  });

  it('accetta due riserve dello stesso veicolo su finestre disgiunte', async () => {
    await givenFleet(1);
    const first = await givenRideRequest('anna@example.com');
    const second = await givenRideRequest('bruno@example.com');

    await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: first, window });
    const later = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: second,
      window: immediateReservationWindow(new Date('2026-05-04T12:00:00.000Z'), 5, 20),
    });

    expect(later.reserved).toBe(true);
    expect(await harness.countRows('robotaxi_reservation')).toBe(2);
  });

  it('non riserva un veicolo che non esiste', async () => {
    const requestId = await givenRideRequest();

    const outcome = await persistence.reserve({
      robotaxiId: 'RT-fantasma',
      rideRequestId: requestId,
      window,
    });

    expect(outcome).toEqual({ reserved: false, reason: 'UNKNOWN_ROBOTAXI' });
  });

  it('scrive prenotazione e riserva nella stessa transazione', async () => {
    await givenFleet(1);
    const requestId = await givenRideRequest();

    const scheduledPickup = new Date('2026-05-05T08:00:00.000Z');
    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: requestId,
      window: advanceReservationWindow(scheduledPickup, 8, 25),
      booking: {
        robotaxiId: 'RT-01',
        scheduledPickup,
        activationDueAt: new Date('2026-05-05T07:45:00.000Z'),
        activatedAt: null,
      },
    });

    expect(outcome.reserved).toBe(true);
    if (!outcome.reserved) return;
    // La prenotazione non dichiara la richiesta né la riserva: le eredita, quindi non possono
    // puntare altrove.
    expect(outcome.booking?.reservationId).toBe(outcome.reservation.id);
    expect(outcome.booking?.rideRequestId).toBe(requestId);
    expect(await harness.countRows('booking')).toBe(1);
  });

  it('quando la riserva è rifiutata non lascia nemmeno la prenotazione', async () => {
    await givenFleet(1);
    const first = await givenRideRequest('anna@example.com');
    const second = await givenRideRequest('bruno@example.com');

    const scheduledPickup = new Date('2026-05-05T08:00:00.000Z');
    const contested = advanceReservationWindow(scheduledPickup, 8, 25);
    await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: first, window: contested });

    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: second,
      window: contested,
      booking: {
        robotaxiId: 'RT-01',
        scheduledPickup,
        activationDueAt: new Date('2026-05-05T07:45:00.000Z'),
        activatedAt: null,
      },
    });

    // O entrambe le righe o nessuna: una prenotazione senza riserva impegnerebbe un veicolo che
    // qualcun altro può prendersi.
    expect(outcome).toEqual({ reserved: false, reason: 'OVERLAPPING_RESERVATION' });
    expect(await harness.countRows('booking')).toBe(0);
    expect(await harness.countRows('robotaxi_reservation')).toBe(1);
  });
});

describe('[NFR1][G10] Due richieste per lo stesso veicolo', () => {
  it('esattamente una riesce, e resta una sola riserva', async () => {
    await givenFleet(1);
    const first = await givenRideRequest('anna@example.com');
    const second = await givenRideRequest('bruno@example.com');
    const window = immediateReservationWindow(NOW, 5, 20);

    const outcomes = await Promise.all([
      persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: first, window }),
      persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: second, window }),
    ]);

    const rejected = outcomes.filter((outcome) => !outcome.reserved);
    expect(outcomes.filter((outcome) => outcome.reserved)).toHaveLength(1);
    expect(await harness.countRows('robotaxi_reservation')).toBe(1);

    // Il motivo del rifiuto dipende da quale delle due arriva prima al blocco di riga, e nessuna
    // delle due possibilità è un difetto: o la perdente trova il veicolo occupato da una
    // transazione in corso (`SKIP LOCKED`, e rinuncia subito invece di accodarsi), o lo trova
    // libero e allora è il vincolo di esclusione a fermarla. Asserire l'insieme dei motivi
    // ammessi è ciò che il test può davvero garantire; pretenderne uno solo lo renderebbe
    // instabile.
    expect(rejected).toHaveLength(1);
    expect(['ROBOTAXI_BUSY', 'OVERLAPPING_RESERVATION']).toContain(
      rejected[0]?.reserved === false ? rejected[0].reason : undefined,
    );
  });
});

describe('[NFR4][G10] Rilascio di una riserva (R14)', () => {
  const scheduledPickup = new Date('2026-05-05T08:00:00.000Z');
  const booked = advanceReservationWindow(scheduledPickup, 8, 25);

  it('una prenotazione annullata restituisce al pool l’intera finestra', async () => {
    await givenFleet(1);
    const requestId = await givenRideRequest();

    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: requestId,
      window: booked,
    });
    if (!outcome.reserved) throw new Error('la riserva doveva riuscire');
    expect(await persistence.filterAvailable(['RT-01'], booked)).toEqual([]);

    // L'annullamento arriva **prima** che la finestra cominci: restringere l'intervallo non
    // servirebbe, perché un intervallo vuoto lo schema lo vieta e uno di un istante lascerebbe
    // comunque il veicolo occupato. Si rilascia (DD §2.4, "Cancellation").
    harness.clock.setNow('2026-05-04T12:00:00.000Z');
    const released = await persistence.update('robotaxi_reservation', outcome.reservation.id, {
      releasedAt: harness.clock.now(),
    });

    expect(released.releasedAt?.toISOString()).toBe('2026-05-04T12:00:00.000Z');
    expect(await persistence.filterAvailable(['RT-01'], booked)).toEqual(['RT-01']);
  });

  it('la riserva rilasciata resta nello storico e non blocca più il vincolo', async () => {
    await givenFleet(1);
    const first = await givenRideRequest('anna@example.com');
    const second = await givenRideRequest('bruno@example.com');

    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: first,
      window: booked,
    });
    if (!outcome.reserved) throw new Error('la riserva doveva riuscire');
    await persistence.update('robotaxi_reservation', outcome.reservation.id, {
      releasedAt: NOW,
    });

    // Il vincolo è parziale su `released_at IS NULL`: la stessa identica finestra torna
    // prenotabile, e la riga rilasciata resta per lo storico.
    const again = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: second,
      window: booked,
    });

    expect(again.reserved).toBe(true);
    expect(await harness.countRows('robotaxi_reservation')).toBe(2);
  });

  it('segnala con un errore tipizzato l’estensione che collide con una riserva successiva', async () => {
    await givenFleet(1);
    const running = await givenRideRequest('anna@example.com');
    const later = await givenRideRequest('bruno@example.com');

    const current = immediateReservationWindow(NOW, 5, 20);
    const outcome = await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: running,
      window: current,
    });
    if (!outcome.reserved) throw new Error('la riserva doveva riuscire');

    const next = immediateReservationWindow(new Date('2026-05-04T10:00:00.000Z'), 5, 20);
    await persistence.reserve({ robotaxiId: 'RT-01', rideRequestId: later, window: next });

    // DD §2.4: "if a ride overruns its reserved interval the interval is extended; should the
    // extension collide with a later reservation…". La collisione dev'essere un errore del
    // dominio, non un errore del driver che esce dal modulo come guasto.
    await expect(
      persistence.update('robotaxi_reservation', outcome.reservation.id, {
        period: { start: current.start, end: new Date('2026-05-04T10:30:00.000Z') },
      }),
    ).rejects.toThrow(ReservationConflictError);
  });
});

describe('Persistence: interrogazione', () => {
  it('trova per uguaglianza', async () => {
    await givenRideRequest('anna@example.com');

    const found = await persistence.find('user', { where: { email: 'anna@example.com' } });

    expect(found).toHaveLength(1);
    expect(found[0]?.role).toBe('PASSENGER');
  });

  it('trova per confronto: è come si troveranno le prenotazioni dovute (D9)', async () => {
    await givenFleet(1);
    const requestId = await givenRideRequest();

    const scheduledPickup = new Date('2026-05-05T08:00:00.000Z');
    await persistence.reserve({
      robotaxiId: 'RT-01',
      rideRequestId: requestId,
      window: advanceReservationWindow(scheduledPickup, 8, 25),
      booking: {
        robotaxiId: 'RT-01',
        scheduledPickup,
        activationDueAt: new Date('2026-05-05T07:45:00.000Z'),
        activatedAt: null,
      },
    });

    const notYet = await persistence.find('booking', {
      where: { activationDueAt: { atMost: new Date('2026-05-05T07:00:00.000Z') } },
    });
    const due = await persistence.find('booking', {
      where: {
        activationDueAt: { atMost: new Date('2026-05-05T07:45:00.000Z') },
        activatedAt: null,
      },
    });

    expect(notYet).toEqual([]);
    expect(due).toHaveLength(1);
  });

  it('ordina per id crescente quando non le si dice altro', async () => {
    await givenFleet(3);

    const fleet = await persistence.find('robotaxi');

    expect(fleet.map((robotaxi) => robotaxi.id)).toEqual(['RT-01', 'RT-02', 'RT-03']);
  });

  it('rispetta ordinamento e limite quando glieli si indica', async () => {
    await givenFleet(3);

    const fleet = await persistence.find('robotaxi', {
      orderBy: [{ field: 'id', direction: 'desc' }],
      limit: 2,
    });

    expect(fleet.map((robotaxi) => robotaxi.id)).toEqual(['RT-03', 'RT-02']);
  });

  it('trova con un insieme di appartenenza', async () => {
    await givenFleet(3);

    const some = await persistence.find('robotaxi', {
      where: { id: { oneOf: ['RT-01', 'RT-03'] } },
    });

    expect(some.map((robotaxi) => robotaxi.id)).toEqual(['RT-01', 'RT-03']);
  });

  it('su nessun risultato restituisce un elenco vuoto, non un errore', async () => {
    expect(await persistence.find('robotaxi', { where: { state: 'MAINTENANCE' } })).toEqual([]);
  });
});
