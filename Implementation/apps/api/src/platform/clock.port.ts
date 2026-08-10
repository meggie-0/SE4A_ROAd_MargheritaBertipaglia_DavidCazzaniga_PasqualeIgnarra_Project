/**
 * Accesso al tempo.
 *
 * Nel codice di dominio non esistono `new Date()` né `Date.now()` (CLAUDE.md Regola 3): l'ora si
 * chiede sempre a questa porta. Serve perché prenotazioni anticipate, isteresi dello switch di
 * strategia e rebalancing sono definiti sul tempo, e un test che dipende dall'orologio di sistema
 * fallisce a caso — cioè peggio che non esistere (HARNESS.md §2).
 *
 * La classe è astratta e non un'interfaccia perché fa anche da token di iniezione per Nest.
 */
export abstract class ClockPort {
  /** L'istante corrente. */
  abstract now(): Date;
}
