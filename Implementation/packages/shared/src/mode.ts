import { z } from 'zod';

import { CONTROL_MODES, STRATEGY_NAMES } from './domain.js';

/**
 * Il contratto pubblico del **modo di controllo** Auto/Manual (RASD R12, R13; NFR9, NFR10;
 * DD §2.4 Figura 2.6).
 *
 * NFR10 nella formulazione falsificabile del DD §4.3 chiede che il modo corrente sia «always
 * visible on the dashboard», e NFR6 che modo **e** strategia attiva si vedano «on the dashboard's
 * first render, without navigating». Per questo la risposta porta entrambi i valori: sono i due
 * campi del pannello strategia del DD §3.2, e separarli su due chiamate obbligherebbe la dashboard
 * a mostrarne uno prima dell'altro — cioè a rendere osservabile uno stato intermedio che nel
 * database non esiste, visto che il record `system_mode` li tiene su una riga sola (decisione D6).
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
