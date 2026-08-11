import type { ZoneCentroid } from './geo.js';

/**
 * Le zone di Milano su cui opera il prototipo (MILESTONES.md §M1).
 *
 * Sta in `packages/shared` per due ragioni concrete: `nearestZone()` ha bisogno dell'elenco per
 * decidere l'appartenenza di un punto, e la dashboard di M8 disegna queste stesse zone sulla mappa
 * senza poter importare nulla da `apps/api` (CLAUDE.md Regola 1).
 *
 * I centroidi sono **indicativi**, presi dal centro riconoscibile di ciascuna area. Non c'è un
 * raggio: le zone formano una partizione di Voronoi sui centroidi (DD §2.2.1, decisione D10),
 * quindi ogni punto della città appartiene a una e una sola zona, senza scoperti né
 * sovrapposizioni — che è ciò che il RASD §2.2.1 intende con "partition".
 */
export interface MilanZone extends ZoneCentroid {
  readonly name: string;
}

export const MILAN_ZONES: readonly MilanZone[] = [
  { id: 'bicocca', name: 'Bicocca', lat: 45.515, lon: 9.211 },
  { id: 'cadorna', name: 'Cadorna', lat: 45.468, lon: 9.175 },
  { id: 'citylife', name: 'CityLife', lat: 45.478, lon: 9.156 },
  { id: 'duomo', name: 'Duomo / Centro', lat: 45.4642, lon: 9.19 },
  { id: 'isola', name: 'Isola', lat: 45.49, lon: 9.19 },
  { id: 'lambrate', name: 'Lambrate', lat: 45.485, lon: 9.238 },
  { id: 'linate', name: 'Linate', lat: 45.4451, lon: 9.2767 },
  { id: 'navigli', name: 'Navigli / Darsena', lat: 45.45, lon: 9.175 },
  { id: 'politecnico-bovisa', name: 'Politecnico Bovisa', lat: 45.503, lon: 9.156 },
  { id: 'politecnico-leonardo', name: 'Politecnico Leonardo', lat: 45.4781, lon: 9.227 },
  { id: 'porta-garibaldi', name: 'Porta Garibaldi', lat: 45.4847, lon: 9.1874 },
  { id: 'porta-romana', name: 'Porta Romana', lat: 45.449, lon: 9.205 },
  { id: 'porta-venezia', name: 'Porta Venezia', lat: 45.474, lon: 9.205 },
  { id: 'rho-fiera', name: 'Rho Fiera', lat: 45.518, lon: 9.085 },
  { id: 'san-siro', name: 'San Siro', lat: 45.4781, lon: 9.124 },
  { id: 'stazione-centrale', name: 'Stazione Centrale', lat: 45.4863, lon: 9.205 },
];

/** La zona con quell'identificatore, o `undefined` se non esiste. */
export function zoneById(id: string): MilanZone | undefined {
  return MILAN_ZONES.find((zone) => zone.id === id);
}
