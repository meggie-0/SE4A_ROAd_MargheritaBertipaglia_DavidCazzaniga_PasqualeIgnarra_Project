import type { ClockPort } from '../platform/clock.port';

/**
 * Una cache a scadenza, con l'orologio preso da fuori.
 *
 * Esiste perché MILESTONES.md §M7 la chiede esplicitamente per l'adapter OSRM («con cache e
 * fallback a stima lineare»), e il motivo è concreto: una singola allocazione chiede lo stesso
 * percorso più volte — la strategia per confrontare i candidati, il comando di rotta per farlo
 * percorrere — e ogni ripetizione sarebbe una chiamata di rete che restituisce lo stesso numero.
 *
 * **La scadenza si misura con `ClockPort`** e mai con l'orologio di sistema (CLAUDE.md Regola 3).
 * Non è un formalismo: una cache che scade sull'ora vera renderebbe un test verde o rosso a seconda
 * di quanto ci ha messo il test precedente, che è il modo più fastidioso di rendere instabile una
 * suite. Con l'orologio iniettato, una voce scade quando il test decide che è scaduta.
 *
 * Lo sfratto è **il più vecchio inserito per primo**, non il meno usato di recente: sulle poche
 * centinaia di voci che questo sistema produce la differenza non si misura, e l'ordine di
 * inserimento è già quello che `Map` mantiene — quindi non c'è una seconda struttura da tenere
 * allineata, e nemmeno un secondo modo di sbagliare.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly clock: ClockPort,
    private readonly ttlSeconds: number,
    private readonly maxEntries: number,
  ) {}

  get(key: string): V | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;

    if (entry.expiresAt <= this.clock.now().getTime()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    // Reinserire una chiave esistente ne rinnova anche la posizione in coda, quindi la voce
    // aggiornata smette di essere la prossima da sfrattare: è l'effetto giusto, perché è appena
    // stata confermata.
    this.entries.delete(key);
    this.entries.set(key, {
      value,
      expiresAt: this.clock.now().getTime() + this.ttlSeconds * 1000,
    });

    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Quante voci sono in cache, scadute comprese. Serve ai test e a nient'altro. */
  get size(): number {
    return this.entries.size;
  }
}
