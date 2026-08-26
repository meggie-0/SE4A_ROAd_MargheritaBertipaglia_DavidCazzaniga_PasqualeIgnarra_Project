import { z } from 'zod';

import { CONTROL_MODES, STRATEGY_NAMES, TRAFFIC_LEVELS } from './domain.js';

/**
 * Il contratto pubblico del **modo di controllo** Auto/Manual (RASD R12, R13; NFR9, NFR10;
 * DD §2.4 Figura 2.6).
 *
 * NFR10 nella formulazione falsificabile del DD §4.3 chiede che il modo corrente sia «always
 * visible on the dashboard», e NFR6 che modo **e** strategia attiva si vedano «on the dashboard's
 * first render, without navigating». Per questo la risposta porta entrambi i valori: sono i due
 * campi del pannello strategia del DD §3.2, e separarli su due chiamate obbligherebbe la dashboard
 * a mostrarne uno prima dell'altro, con due giri di rete fra i due.
 *
 * Al terzo valore — il livello di traffico — dà titolo il RASD §2.3, che fra i bisogni dell'operatore
 * elenca «a clear overview of traffic levels» accanto al modo operativo. Era l'unico dei tre a non
 * avere una via di lettura: il `ModeController` lo persiste a ogni osservazione (decisione D20) e
 * nessuna rotta lo restituiva, quindi il valore esisteva nel database e non raggiungeva lo schermo.
 *
 * **Che cosa la risposta garantisce, con precisione.** Non è uno *snapshot* transazionale: il DD
 * §2.2.1 affida le due letture a due componenti diversi — `AllocationManager` per la strategia,
 * `ModeController` per il modo — quindi il backend le esegue con due interrogazioni distinte sullo
 * stesso record, e una scelta manuale può committare fra le due. Ciò che è garantito è l'unica cosa
 * che conta per NFR10: **il modo non è mai più vecchio della strategia**, perché è letto per ultimo.
 * Un intervento umano già avvenuto non può quindi essere mostrato come modo Auto; il caso opposto —
 * modo `MANUAL` con la strategia di un istante prima — è possibile e si corregge alla richiesta
 * successiva.
 *
 * Il livello di traffico **non aggiunge una terza interrogazione**: viaggia con il modo, perché sono
 * due colonne dello stesso record e lo stesso componente le possiede (decisione D74). Le letture
 * restano due e il livello è quindi sempre coerente con il modo accanto a cui viene mostrato — la
 * coppia che l'operatore usa per capire se il sistema sta ancora decidendo da solo.
 */

/**
 * `GET /mode` e `PUT /mode`: la stessa forma, perché descrivono la stessa risorsa.
 *
 * La `PUT` risponde con il risultato e non con l'eco della richiesta, ed è qui che la differenza
 * conta davvero: `enableAuto()` **rivaluta subito** l'ultimo livello di traffico noto (decisione
 * D11), quindi la strategia dopo il rientro in Auto può non essere quella che l'operatore aveva
 * scelto a mano. Senza questo campo nella risposta l'operatore dovrebbe fare una seconda chiamata
 * per sapere che cosa ha appena provocato.
 */
export const modeResponseSchema = z.object({
  mode: z.enum(CONTROL_MODES),
  activeStrategy: z.enum(STRATEGY_NAMES),
  /**
   * L'ultimo livello di traffico osservato, `null` se nessuna lettura è ancora arrivata.
   *
   * **L'annullabilità non è difensiva, è un terzo stato con un significato proprio.** Un sistema
   * appena partito non ha ancora interrogato il servizio di mappe, e in quell'istante «traffico
   * basso» sarebbe un'affermazione che nessuno ha verificato: `enableAuto()` distingue i due casi
   * esattamente così, e non rivaluta nulla quando il livello è nullo (decisione D11). La dashboard
   * deve poter dire «non ancora rilevato» invece di mostrare un livello inventato.
   *
   * Non è il livello che *giustifica* la strategia attiva, ed è una differenza che conta in modo
   * Manual: là le letture continuano a registrarsi ma non commutano niente (R13), quindi il campo
   * può indicare `HIGH` mentre è attiva la politica scelta a mano. È voluto — è precisamente ciò
   * che l'operatore deve vedere per decidere se il suo intervento ha ancora senso.
   */
  trafficLevel: z.enum(TRAFFIC_LEVELS).nullable(),
});
export type ModeResponse = z.infer<typeof modeResponseSchema>;

/**
 * `PUT /mode` — il rientro in modo Auto.
 *
 * Il corpo ammette **solo** `AUTO`, e non è una restrizione arbitraria: in modo Manual non ci si
 * porta dichiarandolo, ci si finisce scegliendo una strategia (`PUT /allocation/strategy`), perché
 * R13 lega le due cose — «if the Operator manually selects a specific allocation strategy […] the
 * system immediately transitions to Manual Mode». Un `PUT /mode` con `MANUAL` dovrebbe inventarsi
 * quale strategia rendere attiva, e il documento non gliene dà una.
 *
 * Lo schema è quindi la parte di R13 che il contratto sa far valere da solo: l'unica via per il
 * modo Manual passa dalla scelta di una politica, e l'unica via per il modo Auto è questa.
 */
export const enableAutoModeRequestSchema = z.object({
  mode: z.literal('AUTO'),
});
export type EnableAutoModeRequest = z.infer<typeof enableAutoModeRequestSchema>;
