import { haversineKm, type GeoPoint } from '@road/shared';

export const MILAN_SERVICE_AREA = {
  south: 45.39,
  west: 9.05,
  north: 45.54,
  east: 9.31,
} as const;

export const LINATE_TERMINAL_POINT: GeoPoint = {
  lat: 45.4618,
  lon: 9.2786,
};

export const LINATE_SERVICE_RADIUS_METERS = 700;

/**
 * Formato Leaflet:
 * [[latitudine sud, longitudine ovest],
 *  [latitudine nord, longitudine est]]
 */
export const MILAN_SERVICE_BOUNDS: [[number, number], [number, number]] = [
  [MILAN_SERVICE_AREA.south, MILAN_SERVICE_AREA.west],
  [MILAN_SERVICE_AREA.north, MILAN_SERVICE_AREA.east],
];

export function isInsideMilanServiceArea(point: GeoPoint): boolean {
  return (
    point.lat >= MILAN_SERVICE_AREA.south &&
    point.lat <= MILAN_SERVICE_AREA.north &&
    point.lon >= MILAN_SERVICE_AREA.west &&
    point.lon <= MILAN_SERVICE_AREA.east
  );
}

/**
 * Linate è raggiungibile anche se il geocoder la associa a un comune
 * diverso da Milano. La tolleranza copre il terminal e le strade di accesso.
 */
export function isInsideLinateAirportArea(point: GeoPoint): boolean {
  return haversineKm(point, LINATE_TERMINAL_POINT) <= LINATE_SERVICE_RADIUS_METERS / 1_000;
}

export function isLinateAirportAddress(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLocaleLowerCase('it-IT');
  const mentionsLinate = normalized.includes('linate');

  const describesAirportAccess =
    normalized.includes('aeroporto') ||
    normalized.includes('airport') ||
    normalized.includes('terminal') ||
    normalized.includes('gate') ||
    normalized.includes('kiss&ride') ||
    normalized.includes('kiss and ride');

  return mentionsLinate && describesAirportAccess;
}

export function isLinateAirportQuery(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  const normalized = value.trim().toLocaleLowerCase('it-IT').replace(/\s+/g, ' ');

  const firstTerm = normalized.split(' ')[0] ?? '';

  const autocompleteTerms = [
    'aeroporto',
    'airport',
    'linate',
    'terminal',
    'gate',
    'kiss&ride',
    'kiss',
  ];

  const matchesAutocomplete =
    firstTerm.length >= 3 && autocompleteTerms.some((term) => term.startsWith(firstTerm));

  if (matchesAutocomplete) {
    return true;
  }

  const directQueries = [
    'lin',
    'linate',
    'milano linate',
    'aeroporto',
    'aeroporto linate',
    'aeroporto di linate',
    'aeroporto milano',
    'aeroporto di milano linate',
    'linate aeroporto',
    'terminal',
    'terminal linate',
    'gate',
    'kiss&ride',
    'kiss and ride',
    'kiss&ride linate',
    'kiss and ride linate',
    'arrivi linate',
    'partenze linate',
  ];

  if (directQueries.includes(normalized)) {
    return true;
  }

  const numberedGate = /^gate\s*[a-z]?\d+[a-z]?$/i.test(normalized);
  const numberedTerminal = /^terminal\s*\d+$/i.test(normalized);

  if (numberedGate || numberedTerminal) {
    return true;
  }

  const mentionsLinate = normalized.includes('linate');
  const mentionsAirportAccess =
    normalized.includes('aeroporto') ||
    normalized.includes('airport') ||
    normalized.includes('terminal') ||
    normalized.includes('gate') ||
    normalized.includes('arrivi') ||
    normalized.includes('partenze') ||
    normalized.includes('kiss&ride') ||
    normalized.includes('kiss and ride');

  const mentionsForlaniniAirport =
    normalized.includes('forlanini') &&
    (normalized.includes('aeroporto') || normalized.includes('airport'));

  return (mentionsLinate && mentionsAirportAccess) || mentionsForlaniniAirport;
}
