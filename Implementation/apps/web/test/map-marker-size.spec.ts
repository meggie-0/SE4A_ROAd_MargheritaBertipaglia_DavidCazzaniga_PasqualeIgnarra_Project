import { robotaxiMarkerSize, serviceZoneMarkerSize } from '../src/map-marker-size';

describe('dimensione dei marker della dashboard operatore', () => {
  it('riduce i taxi durante lo zoom-out', () => {
    expect(robotaxiMarkerSize(11)).toBe(18);
    expect(robotaxiMarkerSize(12)).toBe(22);
    expect(robotaxiMarkerSize(13)).toBe(26);
    expect(robotaxiMarkerSize(15)).toBe(34);
  });

  it('limita la dimensione dei taxi', () => {
    expect(robotaxiMarkerSize(10)).toBe(18);
    expect(robotaxiMarkerSize(18)).toBe(34);
  });

  it('ridimensiona le zone meno aggressivamente', () => {
    expect(serviceZoneMarkerSize(11)).toBe(22);
    expect(serviceZoneMarkerSize(12)).toBe(25);
    expect(serviceZoneMarkerSize(13)).toBe(29);
    expect(serviceZoneMarkerSize(14)).toBe(32);
  });
});
