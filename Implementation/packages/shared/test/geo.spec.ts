import { MILAN_ZONES, haversineKm, nearestZone, zoneById } from '../src/index.js';

/**
 * La geometria del dominio è quella su cui poggiano due decisioni di progetto: la metrica di
 * `NearestAvailableStrategy` (M3) e l'appartenenza di un punto a una zona (decisione D10).
 *
 * Nessuno di questi test porta il tag di un requisito: `haversineKm` e `nearestZone` sono
 * strumenti, non requisiti. Sono qui perché ciò che ci si costruisce sopra sia degno di fiducia —
 * un pareggio risolto in modo instabile renderebbe instabili i test di M3 e M6, e si finirebbe a
 * cercare il difetto nel posto sbagliato.
 */
describe('Shared: distanza haversine', () => {
  it('la distanza da un punto a se stesso è zero', () => {
    expect(haversineKm({ lat: 45.4642, lon: 9.19 }, { lat: 45.4642, lon: 9.19 })).toBe(0);
  });

  it('un grado di latitudine misura circa 111,2 km', () => {
    // Il valore di riferimento della formula: 2πR/360 con R = 6371 km. Se la distanza fosse
    // sbagliata di un fattore, questo test lo vedrebbe subito.
    expect(haversineKm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111.19, 1);
  });

  it('è simmetrica', () => {
    const duomo = { lat: 45.4642, lon: 9.19 };
    const linate = { lat: 45.4451, lon: 9.2767 };

    expect(haversineKm(duomo, linate)).toBeCloseTo(haversineKm(linate, duomo), 10);
  });

  it('colloca le zone di Milano a distanze plausibili', () => {
    const duomo = zoneById('duomo');
    const sanSiro = zoneById('san-siro');
    if (duomo === undefined || sanSiro === undefined) throw new Error('zone mancanti');

    // Duomo–San Siro sono poco più di cinque chilometri in linea d'aria.
    expect(haversineKm(duomo, sanSiro)).toBeGreaterThan(4);
    expect(haversineKm(duomo, sanSiro)).toBeLessThan(7);
  });
});

describe('Shared: appartenenza di un punto a una zona (decisione D10)', () => {
  it('senza zone non restituisce nulla', () => {
    expect(nearestZone({ lat: 45.46, lon: 9.19 }, [])).toBeNull();
  });

  it.each(MILAN_ZONES.map((zone) => [zone.id, zone] as const))(
    'il centroide di %s appartiene alla propria zona',
    (id, zone) => {
      expect(nearestZone(zone, MILAN_ZONES)?.id).toBe(id);
    },
  );

  it('un punto qualsiasi cade sempre in una zona: la partizione non lascia scoperti', () => {
    // Una griglia su Milano. Con un raggio invece della partizione di Voronoi, alcuni di questi
    // punti non apparterrebbero ad alcuna zona — il difetto che la decisione D10 esclude.
    for (let lat = 45.42; lat <= 45.54; lat += 0.01) {
      for (let lon = 9.05; lon <= 9.3; lon += 0.01) {
        expect(nearestZone({ lat, lon }, MILAN_ZONES)).not.toBeNull();
      }
    }
  });

  it('a parità di distanza vince l’id lessicograficamente minore', () => {
    const equidistant = [
      { id: 'zeta', lat: 0, lon: -1 },
      { id: 'alfa', lat: 0, lon: 1 },
    ];

    // I due centroidi sono esattamente alla stessa distanza dall'origine: senza la regola sui
    // pareggi l'esito dipenderebbe dall'ordine dell'elenco, che nel sistema vero è l'ordine con
    // cui il database restituisce le righe.
    expect(nearestZone({ lat: 0, lon: 0 }, equidistant)?.id).toBe('alfa');
    expect(nearestZone({ lat: 0, lon: 0 }, [...equidistant].reverse())?.id).toBe('alfa');
  });

  it('un punto vicino al Duomo appartiene al Duomo', () => {
    expect(nearestZone({ lat: 45.4655, lon: 9.1905 }, MILAN_ZONES)?.id).toBe('duomo');
  });
});

describe('Shared: catalogo delle zone di Milano', () => {
  it('contiene le 16 zone di MILESTONES.md §M1', () => {
    expect(MILAN_ZONES).toHaveLength(16);
  });

  it('non ha identificatori ripetuti', () => {
    const ids = MILAN_ZONES.map((zone) => zone.id);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ha coordinate dentro il riquadro di Milano', () => {
    for (const zone of MILAN_ZONES) {
      expect(zone.lat).toBeGreaterThan(45.4);
      expect(zone.lat).toBeLessThan(45.56);
      expect(zone.lon).toBeGreaterThan(9.0);
      expect(zone.lon).toBeLessThan(9.32);
    }
  });
});
