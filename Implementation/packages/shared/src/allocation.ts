import { z } from 'zod';

import { STRATEGY_NAMES } from './domain.js';

/**
 * Il contratto pubblico della strategia di allocazione (RASD R8, G5; DD §2.3.1).
 *
 * R8 chiede che l'operatore possa cambiare la politica di allocazione **a runtime, senza
 * interruzione del servizio**: due sole operazioni HTTP, una in lettura e una in scrittura, sulla
 * stessa risorsa — la strategia attiva del sistema.
 *
 * Il nome della strategia, e non un oggetto strategia, è ciò che attraversa il confine
 * (DD §2.2.1): il client non conosce le classi concrete, e l'insieme dei valori ammessi è quello
 * di `STRATEGY_NAMES`, cioè lo stesso da cui la migrazione di M1 ha generato il vincolo `CHECK`
 * della colonna `system_mode.active_strategy`. Aggiungere una politica significa quindi
 * aggiungere una classe, registrarla, estendere quella tupla e migrare la colonna: il codice di
 * `AllocationManager` non cambia (NFR7).
 */

/**
 * `GET /allocation/strategy`.
 *
 * Oggi porta il solo campo che il modulo `allocation` sa dire. Il modo di controllo Auto/Manual,
 * che la dashboard mostra accanto alla strategia (DD §3.2), si legge da `ModePort.getMode()` e
 * arriva con M6: aggiungerlo qui adesso significherebbe farlo uscire da una porta che il DD §2.2.1
 * non gli assegna.
 */
export const activeStrategyResponseSchema = z.object({
  activeStrategy: z.enum(STRATEGY_NAMES),
});
export type ActiveStrategyResponse = z.infer<typeof activeStrategyResponseSchema>;

/**
 * `PUT /allocation/strategy` — la scelta dell'operatore.
 *
 * `PUT` e non `POST`: la richiesta descrive lo stato in cui la risorsa deve trovarsi dopo, ed è
 * idempotente — rimandare la stessa strategia due volte lascia il sistema dov'era.
 */
export const setActiveStrategyRequestSchema = z.object({
  strategy: z.enum(STRATEGY_NAMES),
});
export type SetActiveStrategyRequest = z.infer<typeof setActiveStrategyRequestSchema>;
