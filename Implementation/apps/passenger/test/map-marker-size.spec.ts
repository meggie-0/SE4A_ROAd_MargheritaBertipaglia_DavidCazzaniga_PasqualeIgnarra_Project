import { passengerRobotaxiMarkerSize, serviceZoneMarkerSize } from '../src/map-marker-size';

describe("dimensione dei marker dell'app passeggero", () => {
  it('ridimensiona moderatamente il taxi', () => {
    expect(passengerRobotaxiMarkerSize(11)).toBe(34);
    expect(passengerRobotaxiMarkerSize(12)).toBe(37);
    expect(passengerRobotaxiMarkerSize(13)).toBe(39);
    expect(passengerRobotaxiMarkerSize(14)).toBe(42);
  });

  it('limita la dimensione del taxi', () => {
    expect(passengerRobotaxiMarkerSize(10)).toBe(34);
    expect(passengerRobotaxiMarkerSize(18)).toBe(42);
  });

  it('riduce le icone delle zone durante lo zoom-out', () => {
    expect(serviceZoneMarkerSize(11)).toBe(22);
    expect(serviceZoneMarkerSize(12)).toBe(25);
    expect(serviceZoneMarkerSize(13)).toBe(29);
    expect(serviceZoneMarkerSize(14)).toBe(32);
  });
});
