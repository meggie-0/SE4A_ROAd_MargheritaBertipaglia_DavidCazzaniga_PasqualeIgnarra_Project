import type { ZoneDemand } from '@road/shared';

/**
 * La metrica della domanda attesa e i suoi ordinamenti (DD §2.2.1, decisione D12).
 *
 * Funzioni **pure**: ricevono righe già lette e restituiscono numeri. Non leggono l'orologio, non
 * interrogano il database, non fanno I/O. È ciò che permette di verificare la formula e gli
 * ordinamenti — la parte che i test del cancello di M6 devono poter costruire caso per caso — senza
 * alzare un Postgres, e di verificare separatamente che il manager legga le righe giuste.
 *
 * ```
 * domandaAttesa(z, t) = base(z, fasciaOrariaSettimanale(t)) × Π moltiplicatore(e)
 *                                                             per ogni evento e attivo in z a t
 * ```
 *
 * Ogni ordinamento qui dentro è **totale**: a parità di metrica si rompe il pareggio sull'`id`
 * crescente. Senza, l'esito dipenderebbe dall'ordine con cui il database ha restituito le righe, e
 * i test sarebbero instabili — lo stesso criterio già adottato per i pareggi fra strategie
 * (decisione D25).
 */

/** Ciò che serve per stimare la domanda di una zona: la sua base e gli eventi che la moltiplicano. */
export interface ZoneDemandInput {
  readonly zoneId: string;
  readonly zoneName: string;
  /** La base storica nella fascia oraria settimanale corrente. Zero se la zona non ne ha una. */
  readonly baseDemand: number;
  /** Gli eventi **attivi** nella zona in questo istante: `t ∈ [inizio, fine)`. */
  readonly events: readonly { readonly name: string; readonly multiplier: number }[];
  /** I veicoli inattivi (`AVAILABLE`) che si trovano nella zona. */
  readonly availableRobotaxis: number;
}

/**
 * La domanda attesa di una zona: base per il prodotto dei moltiplicatori attivi.
 *
 * Il prodotto e non la somma, ed è la decisione D12: due eventi concomitanti nella stessa zona —
 * una partita e un concerto — moltiplicano l'affluenza, non la sommano, e con la somma un evento
 * di moltiplicatore 1 (cioè «nessun effetto») raddoppierebbe la domanda.
 */
export function expectedDemand(zone: ZoneDemandInput): number {
  return zone.events.reduce((demand, event) => demand * event.multiplier, zone.baseDemand);
}

/**
 * Le zone stimate e ordinate per **domanda attesa decrescente**, pareggi sull'`id` crescente
 * (decisione D12).
 *
 * È l'esito di `analyzeDemand()`: la risposta a R10, «identify high-demand zones». Il deficit
 * viaggia già calcolato perché è la quantità su cui `rebalance()` ordina, e due formule della
 * stessa cosa — una qui e una là — divergerebbero al primo cambiamento.
 */
export function rankByExpectedDemand(zones: readonly ZoneDemandInput[]): ZoneDemand[] {
  const estimated = zones.map((zone): ZoneDemand => {
    const demand = expectedDemand(zone);
    return {
      zoneId: zone.zoneId,
      zoneName: zone.zoneName,
      baseDemand: zone.baseDemand,
      expectedDemand: demand,
      availableRobotaxis: zone.availableRobotaxis,
      deficit: demand - zone.availableRobotaxis,
      activeEvents: zone.events
        .map((event) => event.name)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  });

  return estimated.sort(byDescending((zone) => zone.expectedDemand));
}

/**
 * Le stesse zone ordinate per **deficit decrescente**, pareggi sull'`id` crescente.
 *
 * `rebalance()` prende le zone in quest'ordine, e non in quello della domanda attesa: la zona con
 * più domanda può essere già ben servita, e mandarci un altro veicolo non ridurrebbe l'attesa di
 * nessuno. Ciò che il riposizionamento insegue è lo squilibrio, che è la differenza fra domanda e
 * veicoli sul posto.
 */
export function rankByDeficit(zones: readonly ZoneDemand[]): ZoneDemand[] {
  return [...zones].sort(byDescending((zone) => zone.deficit));
}

/**
 * Il comparatore che tutto il modulo usa: metrica decrescente, `zoneId` crescente sui pareggi.
 *
 * Uno solo, e condiviso, perché due ordinamenti scritti a mano che dovrebbero rompere i pareggi
 * nello stesso modo prima o poi non lo fanno più — e il sintomo sarebbe un test che fallisce una
 * volta su venti.
 */
function byDescending(
  metric: (zone: ZoneDemand) => number,
): (left: ZoneDemand, right: ZoneDemand) => number {
  return (left, right) => {
    const difference = metric(right) - metric(left);
    if (difference !== 0) return difference;
    return left.zoneId < right.zoneId ? -1 : left.zoneId > right.zoneId ? 1 : 0;
  };
}
