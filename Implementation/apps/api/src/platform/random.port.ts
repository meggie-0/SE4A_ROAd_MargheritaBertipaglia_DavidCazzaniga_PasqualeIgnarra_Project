/**
 * Accesso alla casualità.
 *
 * `Math.random()` è vietato nel dominio (CLAUDE.md Regola 3). In produzione dietro questa porta
 * c'è un PRNG con seed da configurazione, nei test una sequenza fissa: in entrambi i casi la
 * sequenza è riproducibile.
 */
export abstract class RandomPort {
  /** Un numero in [0, 1). */
  abstract next(): number;
}
