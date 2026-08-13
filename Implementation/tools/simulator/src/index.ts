/**
 * `@road/simulator` — il simulatore di flotta di M7.
 *
 * Vive fuori da `apps/api` perché **non è dominio**: è il fornitore che sta dall'altra parte di
 * `ExternalServicesPort`, come OSRM sta dall'altra parte della stima dei percorsi. Il giorno in cui
 * la flotta fosse fatta di veicoli veri, questo pacchetto smetterebbe di essere installato e
 * nessun manager cambierebbe di una riga — che è l'affermazione con cui il DD §4.3 rende NFR8
 * falsificabile.
 *
 * `.dependency-cruiser.cjs` lo tiene raggiungibile **solo** da `apps/api/src/external/`: se un
 * altro modulo lo importasse, saprebbe che la flotta è simulata.
 */
export {
  DEFAULT_SIMULATOR_SETTINGS,
  SIMULATED_TIME_SCALE,
  FleetSimulator,
  ticksToCover,
  type FleetSimulatorSettings,
  type VehicleTelemetryReading,
} from './fleet-simulator';
