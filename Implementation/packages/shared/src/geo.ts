/**
 * Geometria del dominio: distanze e appartenenza di un punto a una zona.
 *
 * Sta in `packages/shared` perché serve a più moduli del backend che non possono importarsi a
 * vicenda (CLAUDE.md Regola 1): `persistence` e `rebalancing` per collocare veicoli e domanda
 * nelle zone, `allocation` per la metrica di `NearestAvailableStrategy` (M3). Sono funzioni pure,
 * senza stato e senza I/O: nessuna delle due legge l'orologio o la casualità.
 */

/** Un punto sulla superficie terrestre. Le altitudini del RASD (`GNSSPose`) non ci servono. */
export interface GeoPoint {
  readonly lat: number;
  readonly lon: number;
}

/** Il minimo che serve per collocare un punto: una zona è il suo identificatore e il centroide. */
export interface ZoneCentroid extends GeoPoint {
  readonly id: string;
}

/** Raggio medio terrestre in chilometri, il valore convenzionale della formula dell'emisenoverso. */
const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Distanza in chilometri fra due punti, formula dell'emisenoverso (haversine).
 *
 * È la metrica di `NearestAvailableStrategy` (DD §2.3.1) e quella con cui si decide a quale zona
 * appartiene un punto (decisione D10). Approssima la Terra a una sfera: su scala urbana l'errore
 * è sotto lo 0,5%, e ciò che conta qui è che l'ordinamento sia totale e riproducibile.
 */
export function haversineKm(from: GeoPoint, to: GeoPoint): number {
  const deltaLat = toRadians(to.lat - from.lat);
  const deltaLon = toRadians(to.lon - from.lon);
  const fromLat = toRadians(from.lat);
  const toLat = toRadians(to.lat);

  const a =
    Math.sin(deltaLat / 2) ** 2 + Math.sin(deltaLon / 2) ** 2 * Math.cos(fromLat) * Math.cos(toLat);

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * La zona a cui appartiene un punto (DD §2.2.1, decisione D10).
 *
 * Le zone formano una **partizione di Voronoi** sui centroidi: un punto appartiene alla zona il cui
 * centroide è più vicino in distanza haversine, con i pareggi risolti sull'`id` lessicograficamente
 * minore. Non esiste una colonna raggio: il RASD §2.2.1 dice "partition", e un raggio lascerebbe
 * sia punti scoperti sia sovrapposizioni, cioè esattamente i due difetti che una partizione esclude.
 *
 * Restituisce `null` solo se l'elenco delle zone è vuoto, che nel sistema seminato non accade.
 */
export function nearestZone<Z extends ZoneCentroid>(
  point: GeoPoint,
  zones: readonly Z[],
): Z | null {
  let best: Z | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const zone of zones) {
    const distance = haversineKm(point, zone);
    // Il pareggio si rompe sull'id crescente: senza questa regola l'esito dipenderebbe
    // dall'ordine con cui il database restituisce le righe, e i test sarebbero instabili.
    const closer = distance < bestDistance;
    const tie = distance === bestDistance && best !== null && zone.id < best.id;
    if (closer || tie) {
      best = zone;
      bestDistance = distance;
    }
  }

  return best;
}
