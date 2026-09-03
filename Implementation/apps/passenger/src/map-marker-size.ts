const MIN_MAP_ZOOM = 11;
const MAX_MAP_ZOOM = 14;

const MIN_ROBOTAXI_SIZE = 34;
const MAX_ROBOTAXI_SIZE = 42;

const MIN_ZONE_SIZE = 22;
const MAX_ZONE_SIZE = 32;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function zoomProgress(zoom: number): number {
  const boundedZoom = clamp(zoom, MIN_MAP_ZOOM, MAX_MAP_ZOOM);

  return (boundedZoom - MIN_MAP_ZOOM) / (MAX_MAP_ZOOM - MIN_MAP_ZOOM);
}

export function passengerRobotaxiMarkerSize(zoom: number): number {
  const progress = zoomProgress(zoom);

  return Math.round(MIN_ROBOTAXI_SIZE + progress * (MAX_ROBOTAXI_SIZE - MIN_ROBOTAXI_SIZE));
}

export function serviceZoneMarkerSize(zoom: number): number {
  const progress = zoomProgress(zoom);

  return Math.round(MIN_ZONE_SIZE + progress * (MAX_ZONE_SIZE - MIN_ZONE_SIZE));
}
