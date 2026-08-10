import { FakeClock } from '../../../src/platform/fake-clock';
import { SystemClock } from '../../../src/platform/system-clock';

/**
 * `ClockPort` è la ragione per cui i test su prenotazioni anticipate, isteresi e rebalancing
 * potranno essere stabili (HARNESS.md §2). Qui si verifica che il doppio di test si comporti
 * davvero come un orologio controllabile: se `advance()` sbagliasse, ogni milestone successiva
 * inseguirebbe fallimenti inesistenti.
 */
describe('Platform: ClockPort', () => {
  it('FakeClock resta fermo finché non lo si sposta', () => {
    const clock = new FakeClock('2026-03-01T10:00:00.000Z');

    expect(clock.now().toISOString()).toBe('2026-03-01T10:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-03-01T10:00:00.000Z');
  });

  it('FakeClock avanza esattamente della durata richiesta', () => {
    const clock = new FakeClock('2026-03-01T10:00:00.000Z');

    clock.advance(15 * 60 * 1000);

    expect(clock.now().toISOString()).toBe('2026-03-01T10:15:00.000Z');
  });

  it('FakeClock può essere riportato a un istante preciso, anche indietro', () => {
    const clock = new FakeClock('2026-03-01T10:00:00.000Z');

    clock.advance(60_000);
    clock.setNow('2026-02-28T23:59:00.000Z');

    expect(clock.now().toISOString()).toBe('2026-02-28T23:59:00.000Z');
  });

  it('FakeClock non lascia mutare il proprio stato da fuori', () => {
    const clock = new FakeClock('2026-03-01T10:00:00.000Z');

    const first = clock.now();
    first.setUTCFullYear(1999);

    expect(clock.now().toISOString()).toBe('2026-03-01T10:00:00.000Z');
  });

  it('SystemClock restituisce un istante valido', () => {
    // L'unica asserzione onesta su un orologio reale: che sia un istante, non quale.
    const instant = new SystemClock().now();

    expect(instant).toBeInstanceOf(Date);
    expect(Number.isNaN(instant.getTime())).toBe(false);
  });
});
