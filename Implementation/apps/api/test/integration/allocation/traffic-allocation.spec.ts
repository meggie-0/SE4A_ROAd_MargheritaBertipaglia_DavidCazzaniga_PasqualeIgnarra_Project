import { MILAN_ZONES, haversineKm, nearestZone, type GeoPoint } from '@road/shared';

import { recordOperator, type RecordedOperator } from '../../support/notifications';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * **Sotto traffico il veicolo più vicino non è il più veloce** — e ora il sistema lo sa (D79).
 *
 * È la proprietà per cui R12 esiste, e fino a v1.13 il modello non la conteneva: il traffico
 * commutava la strategia, ma nessuna stima lo leggeva, quindi la strategia a ETA minimo sceglieva
 * sempre il più vicino. Misurato con il generatore della dimostrazione, ETA minimo attivo per tutta
 * la sequenza: **zero** assegnazioni diverse dal più vicino su cinquantuno.
 *
 * Qui la catena è intera e passa dalle porte — richiesta, candidati, strategia, riserva,
 * assegnazione, su Postgres vero — con l'orologio finto: la garanzia deterministica che la
 * dimostrazione, che gira su tempo reale, non può dare.
 *
 * **La configurazione passa da `process.env`**, perché `startApiHarness` compone i moduli come la
 * produzione e legge l'ambiente. Si scrive prima di comporre e si cancella dopo, come fa il cancello
 * di M7 con `OSRM_BASE_URL`: lasciarla accesa accoppierebbe questo file ai successivi.
 */

const START = '2026-05-04T09:00:00.000Z';
const HOOK_TIMEOUT_MS = 180_000;

const DEMO_ENVIRONMENT: Readonly<Record<string, string>> = {
  TRAFFIC_SOURCE: 'scripted',
  // Il centro è scorrevole per il primo minuto, poi congestionato.
  TRAFFIC_SCRIPT: 'LOW:0,HIGH:60',
  TRAFFIC_CENTRE_ZONES: 'duomo,cadorna,porta-venezia,navigli,porta-romana',
  TRAFFIC_TIME_FACTORS: 'MEDIUM:1.6,HIGH:4',
  // Ogni assegnazione lascia la sua riga nel registro dell'operatore (passo 4 della D79).
  ALLOCATION_EXPLANATIONS: 'on',
};
const CENTRE = new Set(DEMO_ENVIRONMENT.TRAFFIC_CENTRE_ZONES?.split(','));

/**
 * La flotta: quattro veicoli attorno al centroide di ciascuna zona.
 *
 * È la disposizione del seed, riscritta qui perché i test non raggiungono l'interno di
 * `persistence`. Distribuita in modo uniforme di proposito: nessun veicolo sta dove sta per favorire
 * il risultato.
 */
const OFFSETS: readonly GeoPoint[] = [
  { lat: 0.001, lon: 0.001 },
  { lat: 0.001, lon: -0.001 },
  { lat: -0.001, lon: 0.001 },
  { lat: -0.001, lon: -0.001 },
];
const FLEET = MILAN_ZONES.flatMap((zone, zoneIndex) =>
  OFFSETS.map((offset, index) => ({
    id: `RT-${String(zoneIndex * OFFSETS.length + index + 1).padStart(2, '0')}`,
    zoneId: zone.id,
    lat: zone.lat + offset.lat,
    lon: zone.lon + offset.lon,
  })),
);

/**
 * I prelievi: **tutti** i punti di una griglia regolare che cadono in centro.
 *
 * Non sono scelti: una griglia di un chilometro scarso sull'area del centro, filtrata con la regola
 * di zona del sistema. Il fenomeno esiste solo in una parte di questi punti — quelli ai bordi del
 * centro, dove un'auto di periferia può arrivare facendo quasi tutta la strada fuori — ed è
 * precisamente ciò che il test deve poter trovare senza che qualcuno gliel'abbia indicato.
 *
 * Il passo è misurato, non scelto a occhio. A mezzo chilometro la griglia dà cento prelievi e il
 * test dura un minuto e mezzo, perché dentro Jest ogni stima su sessantaquattro candidati costa un
 * quarto di secondo — fuori ne costa tre millesimi. A un chilometro dà ventotto prelievi, di cui
 * **quattro** vanno a un veicolo che non è il più vicino: abbastanza perché «almeno uno» non dipenda
 * da un caso solo.
 */
const PICKUPS: readonly GeoPoint[] = (() => {
  const points: GeoPoint[] = [];
  for (let lat = 45.44; lat <= 45.49; lat += 0.01) {
    for (let lon = 9.16; lon <= 9.222; lon += 0.01) {
      const point = { lat: Number(lat.toFixed(4)), lon: Number(lon.toFixed(4)) };
      const zone = nearestZone(point, MILAN_ZONES);
      if (zone !== null && CENTRE.has(zone.id)) points.push(point);
    }
  }
  return points;
})();

let harness: ApiHarness;

beforeAll(async () => {
  for (const [name, value] of Object.entries(DEMO_ENVIRONMENT)) process.env[name] = value;
  harness = await startApiHarness(START);
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
  for (const name of Object.keys(DEMO_ENVIRONMENT)) delete process.env[name];
}, HOOK_TIMEOUT_MS);

interface Assignment {
  readonly pickup: GeoPoint;
  readonly nearest: string;
  readonly chosen: string;
  /** La riga che l'operatore ha letto per questa assegnazione. */
  readonly explanation: string;
}

let dashboard: RecordedOperator;

/**
 * Ogni prelievo della griglia, uno per volta, sulla stessa flotta intatta.
 *
 * La corsa si annulla subito dopo l'assegnazione (R14), così il veicolo torna disponibile e il
 * prelievo successivo trova la flotta com'era: senza, l'esito di un punto dipenderebbe da quali
 * veicoli hanno preso i punti prima di lui.
 */
async function assignEveryPickup(secondsAfterStart: number): Promise<readonly Assignment[]> {
  await harness.reset();
  harness.clock.setNow(new Date(new Date(START).getTime() + secondsAfterStart * 1000));

  for (const zone of MILAN_ZONES) {
    await harness.persistence.create('zone', {
      id: zone.id,
      name: zone.name,
      lat: zone.lat,
      lon: zone.lon,
    });
  }
  for (const vehicle of FLEET) {
    await harness.persistence.create('robotaxi', { ...vehicle, state: 'AVAILABLE' });
  }
  const { user } = await harness.auth.register({
    email: 'traffico@example.com',
    password: 'password-di-prova',
    name: 'Giulia',
    surname: 'Rossi',
    phoneNumber: null,
    role: 'PASSENGER',
  });
  await harness.allocation.setActiveStrategy('MINIMUM_ETA', 'manual');
  dashboard = recordOperator(harness.notificationSessions);

  const assignments: Assignment[] = [];
  for (const pickup of PICKUPS) {
    const nearest = FLEET.reduce((best, vehicle) =>
      haversineKm(vehicle, pickup) < haversineKm(best, pickup) ? vehicle : best,
    );
    // Una destinazione in periferia, lontana: il tragitto della corsa non è ciò che si misura.
    const outcome = await harness.rides.submitImmediate({
      passengerId: user.id,
      pickup,
      destination: { lat: 45.515, lon: 9.211 },
    });
    if (!outcome.accepted) throw new Error(`Nessun veicolo per ${pickup.lat},${pickup.lon}.`);

    const explanation =
      dashboard.received.map((one) => one.message).find((m) => m.includes(' assegnato con ')) ?? '';
    dashboard.received.length = 0;
    assignments.push({ pickup, nearest: nearest.id, chosen: outcome.robotaxiId, explanation });
    await harness.rides.cancel(outcome.request.id, user.id);
  }
  return assignments;
}

async function etaOf(robotaxiId: string, pickup: GeoPoint): Promise<number> {
  const vehicle = FLEET.find((candidate) => candidate.id === robotaxiId);
  if (vehicle === undefined) throw new Error(`Veicolo sconosciuto: ${robotaxiId}.`);
  const [estimate] = await harness.external.getETA([{ id: robotaxiId, position: vehicle }], pickup);
  if (estimate === undefined) throw new Error(`Nessuna stima per ${robotaxiId}.`);
  return estimate.etaMinutes;
}

describe('[R5][R8][R12] Con il centro congestionato, ETA minimo sceglie chi arriva prima', () => {
  it('la griglia ha abbastanza prelievi in centro perché il test dica qualcosa', () => {
    expect(PICKUPS.length).toBeGreaterThanOrEqual(20);
  });

  it(
    'con il centro scorrevole ETA minimo sceglie sempre il più vicino',
    async () => {
      const assignments = await assignEveryPickup(0);

      expect(assignments.filter((a) => a.chosen !== a.nearest)).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    'con il centro a HIGH almeno un prelievo va a un veicolo che non è il più vicino — e che arriva prima',
    async () => {
      const assignments = await assignEveryPickup(120);
      const notNearest = assignments.filter((a) => a.chosen !== a.nearest);

      expect(notNearest.length).toBeGreaterThanOrEqual(1);

      // Non basta che sia *diverso*: dev'essere la scelta giusta. Per ciascuno, la stima del veicolo
      // scelto è minore di quella del più vicino, nello stesso istante e con lo stesso traffico.
      for (const { pickup, nearest, chosen } of notNearest) {
        expect(await etaOf(chosen, pickup)).toBeLessThan(await etaOf(nearest, pickup));
      }
    },
    HOOK_TIMEOUT_MS,
  );

  it(
    'l’operatore legge perché: quale strategia, con che tempo, e quanto ci avrebbe messo il più vicino',
    async () => {
      const assignments = await assignEveryPickup(120);

      for (const { nearest, chosen, explanation } of assignments) {
        if (chosen === nearest) {
          expect(explanation).toMatch(
            new RegExp(
              `^${chosen} assegnato con ETA minimo, [0-9]+,[0-9] min — è anche il più vicino$`,
            ),
          );
          continue;
        }

        const shown = new RegExp(
          `^${chosen} assegnato con ETA minimo, ([0-9]+,[0-9]) min — il più vicino, ${nearest}, ne avrebbe impiegati ([0-9]+,[0-9])$`,
        ).exec(explanation);
        expect(shown).not.toBeNull();

        // Il distacco mostrato: la riga deve dimostrare qualcosa a chi la legge, non un decimo di
        // minuto che il lettore attribuirebbe all'arrotondamento.
        const chosenMinutes = Number((shown?.[1] ?? '').replace(',', '.'));
        const nearestMinutes = Number((shown?.[2] ?? '').replace(',', '.'));
        expect(nearestMinutes - chosenMinutes).toBeGreaterThanOrEqual(1);
      }

      // E nessuna di queste righe finisce nello storico degli alert: quello resta i quattro eventi
      // di governo della D77, e qui non ce n'è nessuno.
      expect(await harness.operatorAlerts.recentAlerts(100)).toEqual([]);
    },
    HOOK_TIMEOUT_MS,
  );
});
