import type { GeoPoint } from '@road/shared';

export const MILAN_SERVICE_AREA = {
  south: 45.39,
  west: 9.05,
  north: 45.54,
  east: 9.31,
} as const;

/**
 * Formato Leaflet:
 * [[latitudine sud, longitudine ovest],
 *  [latitudine nord, longitudine est]]
 */
export const MILAN_SERVICE_BOUNDS: [[number, number], [number, number]] = [
  [MILAN_SERVICE_AREA.south, MILAN_SERVICE_AREA.west],
  [MILAN_SERVICE_AREA.north, MILAN_SERVICE_AREA.east],
];

/**
 * Servirà successivamente per verificare risultati di ricerca
 * e posizione GPS.
 */
export function isInsideMilanServiceArea(point: GeoPoint): boolean {
  return (
    point.lat >= MILAN_SERVICE_AREA.south &&
    point.lat <= MILAN_SERVICE_AREA.north &&
    point.lon >= MILAN_SERVICE_AREA.west &&
    point.lon <= MILAN_SERVICE_AREA.east
  );
}
