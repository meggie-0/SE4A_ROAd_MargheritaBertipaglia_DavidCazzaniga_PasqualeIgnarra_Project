import { FixedRandom } from '../../../src/platform/fixed-random';
import { SeededRandom } from '../../../src/platform/seeded-random';

/**
 * `RandomPort` esiste perché la casualità non renda instabile la suite (CLAUDE.md Regola 3).
 * La proprietà che conta è una sola: a parità di seed, la sequenza è identica.
 */
describe('Platform: RandomPort', () => {
  it('SeededRandom produce la stessa sequenza a parità di seed', () => {
    const first = new SeededRandom(42);
    const second = new SeededRandom(42);

    const sequence = Array.from({ length: 10 }, () => first.next());

    expect(sequence).toEqual(Array.from({ length: 10 }, () => second.next()));
  });

  it('SeededRandom produce sequenze diverse con seed diversi', () => {
    const one = new SeededRandom(1);
    const two = new SeededRandom(2);

    expect(Array.from({ length: 5 }, () => one.next())).not.toEqual(
      Array.from({ length: 5 }, () => two.next()),
    );
  });

  it('SeededRandom resta dentro [0, 1)', () => {
    const generator = new SeededRandom(7);

    for (let i = 0; i < 1000; i += 1) {
      const value = generator.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('FixedRandom restituisce i valori dati, ciclicamente', () => {
    const random = new FixedRandom([0, 0.25, 0.75]);

    expect([random.next(), random.next(), random.next(), random.next()]).toEqual([
      0, 0.25, 0.75, 0,
    ]);
  });

  it('FixedRandom rifiuta una sequenza vuota o fuori intervallo', () => {
    expect(() => new FixedRandom([])).toThrow(/almeno un valore/);
    expect(() => new FixedRandom([1])).toThrow(/\[0, 1\)/);
    expect(() => new FixedRandom([-0.1])).toThrow(/\[0, 1\)/);
  });
});
