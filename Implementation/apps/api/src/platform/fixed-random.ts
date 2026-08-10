import { RandomPort } from './random.port';

/**
 * Implementazione di test di `RandomPort`: restituisce i valori dati, ciclicamente.
 *
 * Permette a un test di dire "il prossimo sorteggio vale 0.0" invece di sperare che il PRNG
 * produca il valore che serve.
 */
export class FixedRandom extends RandomPort {
  private index = 0;

  constructor(private readonly sequence: readonly number[] = [0.5]) {
    super();
    if (sequence.length === 0) {
      throw new Error('FixedRandom richiede almeno un valore nella sequenza.');
    }
    const outOfRange = sequence.find((value) => value < 0 || value >= 1);
    if (outOfRange !== undefined) {
      throw new Error(`FixedRandom accetta solo valori in [0, 1): ricevuto ${outOfRange}.`);
    }
  }

  override next(): number {
    const value = this.sequence[this.index % this.sequence.length];
    this.index += 1;
    // `noUncheckedIndexedAccess` è attivo: il costruttore garantisce che l'indice sia valido.
    return value as number;
  }
}
