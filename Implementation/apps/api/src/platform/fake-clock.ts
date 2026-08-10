import { ClockPort } from './clock.port';

/**
 * Implementazione di test di `ClockPort` (HARNESS.md §2): il tempo si sposta solo quando lo sposta
 * il test, con `setNow()` o `advance()`.
 */
export class FakeClock extends ClockPort {
  private current: Date;

  constructor(initial: Date | string = '2026-01-01T08:00:00.000Z') {
    super();
    this.current = typeof initial === 'string' ? new Date(initial) : new Date(initial.getTime());
  }

  override now(): Date {
    return new Date(this.current.getTime());
  }

  /** Porta l'orologio a un istante preciso. */
  setNow(instant: Date | string): void {
    this.current = typeof instant === 'string' ? new Date(instant) : new Date(instant.getTime());
  }

  /** Fa avanzare l'orologio di `milliseconds`. Un valore negativo lo fa tornare indietro. */
  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}
