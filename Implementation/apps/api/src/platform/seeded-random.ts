import { Injectable } from '@nestjs/common';

import { RandomPort } from './random.port';

/**
 * Implementazione di produzione di `RandomPort`: un PRNG con seed esplicito (mulberry32).
 *
 * A parità di seed la sequenza è identica su ogni macchina e a ogni esecuzione. Il seed arriva
 * dalla configurazione (`PLATFORM_RANDOM_SEED`), così una sessione di demo può essere riprodotta
 * esattamente.
 */
@Injectable()
export class SeededRandom extends RandomPort {
  private state: number;

  constructor(seed: number) {
    super();
    // >>> 0 tiene lo stato in 32 bit senza segno, che è ciò su cui mulberry32 è definito.
    this.state = seed >>> 0;
  }

  override next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}
