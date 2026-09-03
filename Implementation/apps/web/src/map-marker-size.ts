const MIN_MAP_ZOOM = 11;

const MAX_ROBOTAXI_ZOOM = 15;
const MIN_ROBOTAXI_SIZE = 18;
const MAX_ROBOTAXI_SIZE = 34;

const MAX_ZONE_ZOOM = 14;
const MIN_ZONE_SIZE = 22;
const MAX_ZONE_SIZE = 32;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function robotaxiMarkerSize(zoom: number): number {
  const boundedZoom = clamp(zoom, MIN_MAP_ZOOM, MAX_ROBOTAXI_ZOOM);
  const progress = (boundedZoom - MIN_MAP_ZOOM) / (MAX_ROBOTAXI_ZOOM - MIN_MAP_ZOOM);

  return Math.round(MIN_ROBOTAXI_SIZE + progress * (MAX_ROBOTAXI_SIZE - MIN_ROBOTAXI_SIZE));
}

export function serviceZoneMarkerSize(zoom: number): number {
  const boundedZoom = clamp(zoom, MIN_MAP_ZOOM, MAX_ZONE_ZOOM);
  const progress = (boundedZoom - MIN_MAP_ZOOM) / (MAX_ZONE_ZOOM - MIN_MAP_ZOOM);

  return Math.round(MIN_ZONE_SIZE + progress * (MAX_ZONE_SIZE - MIN_ZONE_SIZE));
}
