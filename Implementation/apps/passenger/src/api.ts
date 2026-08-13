import {
  API_ROUTES,
  apiRequest,
  authResponseSchema,
  rideRequestResponseSchema,
  userProfileSchema,
  type AuthResponse,
  type GeoPoint,
  type LoginRequest,
  type RegisterRequest,
  type RideRequestResponse,
  type UpdateProfileRequest,
  type UserProfile,
} from '@road/shared';

import { apiBaseUrl } from './api-base-url';

/**
 * Le quattro chiamate che l'app passeggero fa al backend (RASD R1, R2, R3, R4).
 *
 * Ogni funzione è una riga di trasporto: rotta da `API_ROUTES`, corpo dalla forma condivisa,
 * risposta validata con lo schema condiviso. Nessuna logica: il client non decide chi è idoneo, non
 * calcola ETA e non sa cosa sia una strategia — sono cose del backend, e replicarle qui
 * significherebbe avere due implementazioni della stessa regola che divergono.
 *
 * Il file **non importa niente da `apps/api`** e non potrebbe: conosce il backend solo attraverso
 * `contracts/openapi.json` e i tipi di `@road/shared` (CLAUDE.md Regola 1).
 */

export async function login(credentials: LoginRequest): Promise<AuthResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.authLogin, {
    method: 'POST',
    body: credentials,
    schema: authResponseSchema,
  });
}

export async function register(registration: RegisterRequest): Promise<AuthResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.authRegister, {
    method: 'POST',
    body: registration,
    schema: authResponseSchema,
  });
}

/**
 * `PATCH /auth/me` — R2, G1: «update their personal information **and credentials**».
 *
 * Il corpo porta i soli campi che si vogliono cambiare, e almeno uno dev'esserci: lo schema
 * condiviso rifiuta una modifica vuota, perché non è un aggiornamento riuscito di niente.
 * `phoneNumber: null` cancella il numero, ometterlo lo lascia com'è.
 *
 * La risposta è il profilo aggiornato, **senza** la password in nessuna forma: `userProfileSchema`
 * è costruito elencando i campi ammessi, non togliendo quelli vietati.
 */
export async function updateProfile(
  token: string,
  patch: UpdateProfileRequest,
): Promise<UserProfile> {
  return apiRequest(apiBaseUrl, API_ROUTES.authProfile, {
    method: 'PATCH',
    token,
    body: patch,
    schema: userProfileSchema,
  });
}

export interface RideRequestDraft {
  readonly pickup: GeoPoint;
  readonly destination: GeoPoint;
  /** L'orario concordato, in ISO 8601 con fuso: presente solo per una corsa programmata. */
  readonly scheduledPickup?: string;
}

/**
 * `POST /rides/immediate` — R3, G2.
 *
 * Una risposta `REJECTED` **non** è un errore: il RASD (Figura 3.1) prevede il rifiuto come esito
 * del caso d'uso quando nessun veicolo è idoneo, e il backend risponde comunque `201`. È la vista di
 * stato a mostrarlo, non un messaggio d'errore.
 */
export async function requestImmediateRide(
  token: string,
  draft: RideRequestDraft,
): Promise<RideRequestResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.ridesImmediate, {
    method: 'POST',
    token,
    body: { pickup: draft.pickup, destination: draft.destination },
    schema: rideRequestResponseSchema,
  });
}

/** `POST /rides/advance` — R4, G3. Il veicolo non è assegnato adesso, ma poco prima dell'orario. */
export async function requestAdvanceBooking(
  token: string,
  draft: RideRequestDraft & { scheduledPickup: string },
): Promise<RideRequestResponse> {
  return apiRequest(apiBaseUrl, API_ROUTES.ridesAdvance, {
    method: 'POST',
    token,
    body: {
      pickup: draft.pickup,
      destination: draft.destination,
      scheduledPickup: draft.scheduledPickup,
    },
    schema: rideRequestResponseSchema,
  });
}
