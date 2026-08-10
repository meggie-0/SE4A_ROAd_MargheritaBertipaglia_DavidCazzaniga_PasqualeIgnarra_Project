import { Injectable } from '@nestjs/common';

import { ClockPort } from './clock.port';

/**
 * Implementazione di produzione di `ClockPort`: l'orologio di sistema.
 *
 * È l'unico punto del backend in cui `new Date()` è ammesso, ed è per questo che la regola di lint
 * sul determinismo fa un'eccezione per `src/platform/` e per nient'altro.
 */
@Injectable()
export class SystemClock extends ClockPort {
  override now(): Date {
    return new Date();
  }
}
