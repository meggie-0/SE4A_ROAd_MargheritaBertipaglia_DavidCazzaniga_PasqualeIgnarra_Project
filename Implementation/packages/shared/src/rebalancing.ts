import { z } from 'zod';

/**
 * Il contratto pubblico dell'**analisi della domanda** (RASD R10, R11, G9; DD §2.2.1, decisione D12).
 *
 * R10 chiede che il sistema «identifichi le zone ad alta domanda»: è un risultato che esiste solo
 * se qualcuno lo può guardare, e chi lo guarda è l'operatore — il DD §2.11 disegna l'arco
 * `APIGateway → RebalancingManager` proprio per questo. Il riposizionamento vero e proprio non ha
 * un endpoint: lo innesca `RebalancingScheduler` e lo si osserva sul canale push, come ogni altro
 * movimento di flotta (R7, G8).
 */

/**
 * La domanda attesa in una zona a un istante, con i due numeri da cui nasce il deficit.
 *
 * `expectedDemand = baseDemand × Π moltiplicatori degli eventi attivi` (decisione D12), e
 * `deficit = expectedDemand − availableRobotaxis`. Il deficit viaggia già calcolato invece di
 * lasciarlo al client: è la quantità su cui `rebalance()` ordina, e due formule della stessa cosa —
 * una nel backend e una nella dashboard — divergerebbero al primo cambio.
 */
export const zoneDemandSchema = z.object({
  zoneId: z.string(),
  zoneName: z.string(),
  /** La base storica della zona nella fascia oraria settimanale corrente (ora locale di Milano). */
  baseDemand: z.number(),
  expectedDemand: z.number(),
  /** I veicoli **inattivi** che si trovano nella zona: quelli in stato `AVAILABLE`. */
  availableRobotaxis: z.number().int(),
  deficit: z.number(),
  /** I nomi degli eventi attivi nella zona in questo istante, in ordine alfabetico. */
  activeEvents: z.array(z.string()),
});
export type ZoneDemand = z.infer<typeof zoneDemandSchema>;

/**
 * `GET /rebalancing/demand` — le zone per domanda attesa **decrescente**, pareggi sull'`id`
 * crescente (decisione D12).
 *
 * L'ordine fa parte del contratto e non è un dettaglio di comodo: un ordinamento non totale
 * renderebbe la prima riga della tabella diversa a ogni ricarica della dashboard, e i test che
 * dipendono da quell'ordine instabili.
 */
export const demandAnalysisResponseSchema = z.object({
  /** L'istante a cui la stima si riferisce: viene da `ClockPort`, mai dall'orologio di sistema. */
  analyzedAt: z.iso.datetime(),
  zones: z.array(zoneDemandSchema),
});
export type DemandAnalysisResponse = z.infer<typeof demandAnalysisResponseSchema>;
