import type { GeoPoint } from '@road/shared';

/**
 * Un percorso fra due punti, come lo restituisce un fornitore di mappe.
 *
 * È un tipo **interno** al modulo `external`: non compare in nessuna porta, e non deve. Chi sta
 * fuori chiede tempi di arrivo e comanda rotte; la polyline con cui la rotta si realizza è un
 * dettaglio del fornitore, ed è esattamente ciò che NFR8 vuole tenere dentro il gateway (DD §4.3:
 * «nessun componente fuori da `ExternalServicesGateway` cita un protocollo o un SDK di un
 * fornitore»). Se questo tipo attraversasse un confine, un manager di dominio comincerebbe a
 * ragionare in geometrie.
 *
 * I due adapter delle mappe lo producono entrambi — OSRM leggendo la rete, la stima lineare
 * calcolandolo — ed è ciò che permette al primo di ripiegare sul secondo senza che il chiamante se
 * ne accorga.
 */
export interface RouteLeg {
  /**
   * I punti da percorrere, dal primo dopo l'origine fino alla destinazione compresa.
   *
   * La stima lineare ne produce **uno solo**, la destinazione: senza una rete stradale, la strada
   * più breve fra due punti è il segmento che li unisce. OSRM ne produce la geometria vera, ed è
   * la differenza che si vede quando il simulatore fa percorrere la rotta a un veicolo.
   */
  readonly waypoints: readonly GeoPoint[];
  readonly distanceKm: number;
  readonly durationMinutes: number;
}
