/**
 * Le rotte pubblicate dall'API Gateway, in un posto solo.
 *
 * I client non importano nulla da `apps/api` (CLAUDE.md Regola 1): conoscono il backend solo
 * attraverso `contracts/openapi.json` e queste costanti.
 */
export const API_ROUTES = {
  health: '/health',

  // Autenticazione (M1b, RASD R1 e R2). `authProfile` serve sia in lettura sia in aggiornamento:
  // è la stessa risorsa — il profilo di chi porta il token — e distinguerla per verbo è ciò che
  // rende `GET` e `PATCH` due operazioni sulla stessa cosa invece di due rotte da tenere allineate.
  authRegister: '/auth/register',
  authLogin: '/auth/login',
  authProfile: '/auth/me',

  // Strategia di allocazione (M3, RASD R8 e G5). Una risorsa sola, letta e scritta: `GET` la
  // mostra sulla dashboard, `PUT` la cambia a sistema acceso. È riservata all'operatore, e il
  // vincolo di ruolo lo fanno valere i guard di M1b.
  allocationStrategy: '/allocation/strategy',

  // Richieste di corsa (M4, RASD R3, R4 e R14). Due rotte di creazione e non una con un campo
  // discriminante: immediata e anticipata hanno corpi diversi — solo la seconda porta l'orario —
  // e due schemi distinti sono ciò che permette al compilatore e all'OpenAPI di dire quale campo
  // è obbligatorio dove. L'annullamento è una `POST` su una sotto-risorsa e non una `DELETE`:
  // non cancella nulla, cambia lo stato della richiesta in `CANCELLED` e la lascia nello storico.
  ridesImmediate: '/rides/immediate',
  ridesAdvance: '/rides/advance',
  rideBookings: '/rides/bookings',
  rideCancel: '/rides/:rideRequestId/cancel',
  // Dove si trova il veicolo della propria corsa (M8, RASD R3 e R6; decisione D69). Sotto-risorsa
  // della richiesta e non una rotta di flotta, perché la domanda è «dov'è il veicolo della **mia**
  // corsa»: porta con sé un controllo di appartenenza. Risponde *dove*, mai *in che stato* — lo
  // stato viaggia sul canale push, e duplicarlo qui renderebbe NFR2 non più osservabile.
  rideVehicle: '/rides/:rideRequestId/vehicle',

  // Modo di controllo Auto/Manual (M6, RASD R12, R13; NFR9, NFR10). Una risorsa sola: `GET` la
  // mostra sul pannello strategia della dashboard, `PUT` riabilita il modo Auto. Non c'è una rotta
  // per *entrare* in Manual, perché in Manual non ci si porta dichiarandolo: ci si finisce
  // scegliendo una strategia su `allocationStrategy`, che è ciò che R13 prescrive.
  mode: '/mode',

  // Analisi della domanda (M6, RASD R10, G9). Sola lettura: il riposizionamento lo innesca lo
  // scheduler e lo si osserva sul canale push, come ogni altro movimento di flotta.
  rebalancingDemand: '/rebalancing/demand',

  // Rotte per la manutezione programmata del taxi. Il taxi da available viene settato in manutenzione a mano dall'operatore e viene riabilitato alla fine della manutenzione.
  maintenanceStart: '/fleet/:robotaxiId/maintenance',
  maintenanceComplete: '/fleet/:robotaxiId/maintenance/complete',
  // Panoramica della flotta (M8, RASD R7, G8). Sola lettura, riservata all'operatore: è ciò che
  // disegna la mappa e riempie la status bar della dashboard (DD §3.2). Le posizioni **non**
  // viaggiano sul canale push — cambiano a ogni tick e lo inonderebbero (`recordPositions()`) —
  // quindi la dashboard le rilegge da qui; gli eventi di stato continuano ad arrivare push.
  fleetStatus: '/fleet/status',
} as const;

export type ApiRoute = (typeof API_ROUTES)[keyof typeof API_ROUTES];

/**
 * L'indirizzo di annullamento di una richiesta concreta.
 *
 * `API_ROUTES.rideCancel` porta il segnaposto nella forma che Nest si aspetta nel decoratore; un
 * client deve sostituirlo. Farlo qui, una volta, evita che ogni chiamante reinventi la stessa
 * `replace` — e che qualcuno la sbagli scrivendo l'indirizzo a mano.
 */
export const rideCancelRoute = (rideRequestId: string): string =>
  API_ROUTES.rideCancel.replace(':rideRequestId', encodeURIComponent(rideRequestId));

/** L'indirizzo della posizione del veicolo di una corsa concreta. */
export const rideVehicleRoute = (rideRequestId: string): string =>
  API_ROUTES.rideVehicle.replace(':rideRequestId', encodeURIComponent(rideRequestId));

export const maintenanceStartRoute = (robotaxiId: string): string =>
  API_ROUTES.maintenanceStart.replace(':robotaxiId', encodeURIComponent(robotaxiId));

export const maintenanceCompleteRoute = (robotaxiId: string): string =>
  API_ROUTES.maintenanceComplete.replace(':robotaxiId', encodeURIComponent(robotaxiId));
