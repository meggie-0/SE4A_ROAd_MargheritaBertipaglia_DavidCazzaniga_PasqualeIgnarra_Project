import { config, geocoding } from '@maptiler/client';
import type { GeoPoint } from '@road/shared';

import { MILAN_SERVICE_AREA } from './service-area';

export interface AddressSuggestion {
  readonly id: string;
  readonly label: string;
  readonly point: GeoPoint;
}

export interface RoadSnapResult {
  readonly point: GeoPoint;
  readonly distanceMeters: number;
}

const MILAN_CENTER: [number, number] = [9.19, 45.4642];
const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';
const MAX_ROAD_SNAP_DISTANCE_METERS = 150;

const MILAN_BBOX: [number, number, number, number] = [
  MILAN_SERVICE_AREA.west,
  MILAN_SERVICE_AREA.south,
  MILAN_SERVICE_AREA.east,
  MILAN_SERVICE_AREA.north,
];

export async function searchMilanAddresses(query: string): Promise<AddressSuggestion[]> {
  const normalizedQuery = query.trim();

  if (normalizedQuery.length < 3) {
    return [];
  }

  const apiKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim();

  if (apiKey === undefined || apiKey === '') {
    throw new Error('La ricerca degli indirizzi non è configurata.');
  }

  config.apiKey = apiKey;

  const response = await geocoding.forward(normalizedQuery, {
    autocomplete: true,
    bbox: MILAN_BBOX,
    country: ['it'],
    proximity: MILAN_CENTER,
    language: 'it',
    limit: 5,
  });

  return response.features.flatMap((feature): AddressSuggestion[] => {
    const lon = feature.center[0];
    const lat = feature.center[1];

    if (
      typeof lat !== 'number' ||
      typeof lon !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return [];
    }

    return [
      {
        id: String(feature.id ?? `${lon},${lat}`),
        label: feature.place_name,
        point: { lat, lon },
      },
    ];
  });
}

export async function reverseGeocodeMilanPoint(point: GeoPoint): Promise<string | null> {
  const apiKey = import.meta.env.VITE_MAPTILER_API_KEY?.trim();

  if (apiKey === undefined || apiKey === '') {
    throw new Error('La ricerca degli indirizzi non è configurata.');
  }

  config.apiKey = apiKey;

  const response = await geocoding.reverse([point.lon, point.lat], {
    language: 'it',
    limit: 5,
  });

  const feature = response.features.find((candidate) => isReadableAddress(candidate.place_name));

  if (
    feature === undefined ||
    typeof feature.place_name !== 'string' ||
    feature.place_name.trim() === ''
  ) {
    return null;
  }

  return feature.place_name;
}

export async function snapToNearestDrivableRoad(point: GeoPoint): Promise<RoadSnapResult | null> {
  const configuredBaseUrl = import.meta.env.VITE_OSRM_BASE_URL?.trim();

  const baseUrl = (
    configuredBaseUrl === undefined || configuredBaseUrl === ''
      ? DEFAULT_OSRM_BASE_URL
      : configuredBaseUrl
  ).replace(/\/+$/, '');

  const response = await fetch(`${baseUrl}/nearest/v1/driving/${point.lon},${point.lat}?number=1`);

  if (!response.ok) {
    throw new Error('Il servizio stradale non è disponibile.');
  }

  const payload = (await response.json()) as {
    readonly code?: unknown;
    readonly waypoints?: readonly {
      readonly location?: unknown;
      readonly distance?: unknown;
    }[];
  };

  const waypoint = payload.waypoints?.[0];

  if (
    payload.code !== 'Ok' ||
    waypoint === undefined ||
    !Array.isArray(waypoint.location) ||
    waypoint.location.length < 2
  ) {
    throw new Error('Il servizio stradale ha restituito una risposta non valida.');
  }

  const lon = waypoint.location[0];
  const lat = waypoint.location[1];
  const distance = waypoint.distance;

  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    typeof distance !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    !Number.isFinite(distance)
  ) {
    throw new Error('Il punto stradale restituito non è valido.');
  }

  if (distance > MAX_ROAD_SNAP_DISTANCE_METERS) {
    return null;
  }

  return {
    point: { lat, lon },
    distanceMeters: distance,
  };
}

function isReadableAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }

  const primaryName = value.split(',')[0]?.trim() ?? '';

  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(primaryName);
}
