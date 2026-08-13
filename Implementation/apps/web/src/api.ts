import {
  API_ROUTES,
  apiRequest,
  authResponseSchema,
  fleetStatusResponseSchema,
  modeResponseSchema,
  type AuthResponse,
  type FleetStatusResponse,
  type LoginRequest,
  type ModeResponse,
  type StrategyName,
} from '@road/shared';

import { apiBaseUrl } from './api-base-url';

/**
 * Le quattro chiamate che la dashboard fa al backend (RASD R7, R8, R12, R13).
 *
 * Come nell'app passeggero, ogni funzione è una riga di trasporto: rotta da `API_ROUTES`, risposta
 * validata con lo schema condiviso, nessuna logica. La dashboard non decide quale strategia sia
 * giusta — la chiede.
 *
 * **`GET /rebalancing/demand` non è fra queste**, benché la rotta esista dal M6: il DD §3.2 elenca
 * quattro pannelli e nessuno mostra la domanda per zona, quindi una funzione che la leggesse non
 * avrebbe chiamanti. I riposizionamenti l'operatore li vede accadere nel pannello alert, che è la
 * forma in cui il DD glieli mostra.
 *
 * **Non c'è una `PUT /mode` con `MANUAL`**, e non è una dimenticanza del client: R13 lega il modo
 * Manual alla scelta di una politica, quindi ci si entra da `setActiveStrategy()`. Il contratto non
 * offre altra via, e il client non ne inventa una.
 */

export async function login(credentials: LoginRequest): Promise<AuthResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.authLogin, {
    method: 'POST',
    body: credentials,
    schema: authResponseSchema,
  });
}

/** `GET /fleet/status` — R7, G8: posizione e stato di ogni veicolo, più il riepilogo per stato. */
export async function fetchFleetStatus(token: string): Promise<FleetStatusResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.fleetStatus, {
    token,
    schema: fleetStatusResponseSchema,
  });
}

/** `GET /mode` — modo di controllo e strategia attiva insieme, come NFR6 e NFR10 chiedono. */
export async function fetchMode(token: string): Promise<ModeResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.mode, { token, schema: modeResponseSchema });
}

/**
 * `PUT /allocation/strategy` — R8, R13.
 *
 * Porta il sistema in modo Manual nella stessa transazione: è una scelta umana, e da quel momento
 * nessun cambio automatico avviene finché l'operatore non riabilita Auto (NFR10).
 */
export async function setActiveStrategy(
  token: string,
  strategy: StrategyName,
): Promise<{ activeStrategy: StrategyName }> {
  return apiRequest(apiBaseUrl, API_ROUTES.allocationStrategy, {
    method: 'PUT',
    token,
    body: { strategy },
    schema: modeResponseSchema.pick({ activeStrategy: true }),
  });
}

/**
 * `PUT /mode` — il rientro in modo Auto (R13).
 *
 * La risposta porta la strategia **dopo** la rivalutazione immediata dell'ultimo livello di
 * traffico noto (decisione D11), che può non essere quella scelta a mano: per questo si usa il
 * risultato invece di riecheggiare la richiesta.
 */
export async function enableAutoMode(token: string): Promise<ModeResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.mode, {
    method: 'PUT',
    token,
    body: { mode: 'AUTO' },
    schema: modeResponseSchema,
  });
}
