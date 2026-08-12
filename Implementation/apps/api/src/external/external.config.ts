import type { ConfigService } from '@nestjs/config';

/**
 * La configurazione dei fornitori esterni, letta **solo** dall'ambiente (CLAUDE.md, «Cose da non
 * fare»: niente valori di servizio scritti nel codice).
 *
 * Vive in un file suo per la stessa ragione di `jwt.config.ts`: i valori li leggono punti diversi —
 * l'adapter delle mappe e quello della flotta — e due letture indipendenti dello stesso nome
 * divergono al primo refuso.
 *
 * **Ogni valore ha un default che funziona senza rete.** È la condizione che il cancello di M7
 * verifica dalla parte opposta: «con OSRM irraggiungibile il fallback produce comunque un ETA e
 * nessuna richiesta va persa». Un'installazione senza `OSRM_BASE_URL` non è un'installazione rotta,
 * è quella che stima i percorsi in linea d'aria — che è ciò che il sistema faceva fino a M6.
 */

/** Due secondi: oltre, un'allocazione starebbe ferma ad aspettare più di quanto valga la stima. */
export const DEFAULT_OSRM_TIMEOUT_MS = 2000;

/**
 * Sessanta secondi di cache.
 *
 * I percorsi urbani cambiano con il traffico, non da un secondo all'altro: un minuto è abbastanza
 * lungo da assorbire la raffica di richieste di un'allocazione — lo stesso veicolo verso lo stesso
 * ritiro, chiesto dalla strategia e poi dal comando di rotta — e abbastanza corto perché una
 * congestione che si forma non resti nascosta.
 */
export const DEFAULT_OSRM_CACHE_TTL_SECONDS = 60;

/** Quante coppie origine/destinazione la cache tiene prima di dimenticare le più vecchie. */
export const DEFAULT_OSRM_CACHE_ENTRIES = 500;

export interface OsrmSettings {
  /** La radice del servizio, per esempio `http://localhost:5000`. Vuota: adapter disattivato. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly cacheTtlSeconds: number;
  readonly cacheEntries: number;
}

export function readOsrmSettings(config: ConfigService): OsrmSettings {
  return {
    // La barra finale si toglie qui, in un punto solo: `${base}/route/...` con una barra di troppo
    // produce un 404 che sembra un fornitore irraggiungibile, e manderebbe in fallback un OSRM
    // perfettamente funzionante.
    baseUrl: (config.get<string>('OSRM_BASE_URL') ?? '').trim().replace(/\/+$/, ''),
    timeoutMs: positiveInteger(config, 'OSRM_TIMEOUT_MS', DEFAULT_OSRM_TIMEOUT_MS),
    cacheTtlSeconds: positiveInteger(
      config,
      'OSRM_CACHE_TTL_SECONDS',
      DEFAULT_OSRM_CACHE_TTL_SECONDS,
    ),
    cacheEntries: positiveInteger(config, 'OSRM_CACHE_ENTRIES', DEFAULT_OSRM_CACHE_ENTRIES),
  };
}

/**
 * I parametri del simulatore di flotta.
 *
 * La velocità è la stessa assunzione dichiarata che regge la stima lineare degli ETA: cambiandola
 * cambia quanti tick servono per arrivare, non chi arriva prima.
 */
export interface SimulatorSettings {
  readonly speedKmH: number;
  readonly tickMinutes: number;
}

export const DEFAULT_SIMULATOR_SPEED_KMH = 20;
export const DEFAULT_SIMULATOR_TICK_MINUTES = 1;

export function readSimulatorSettings(config: ConfigService): SimulatorSettings {
  return {
    speedKmH: positiveInteger(config, 'SIMULATOR_SPEED_KMH', DEFAULT_SIMULATOR_SPEED_KMH),
    tickMinutes: positiveInteger(config, 'SIMULATOR_TICK_MINUTES', DEFAULT_SIMULATOR_TICK_MINUTES),
  };
}

/**
 * Un intero positivo dall'ambiente, o il default.
 *
 * Un valore malformato **ferma l'avvio** invece di scivolare al default: una variabile scritta male
 * è quasi sempre un errore di configurazione, e silenziarla farebbe girare il sistema con parametri
 * diversi da quelli che chi lo ha configurato crede di avergli dato.
 */
function positiveInteger(config: ConfigService, name: string, fallback: number): number {
  const raw = config.get<string>(name);
  if (raw === undefined || raw.trim() === '') return fallback;

  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} deve essere un intero positivo, non "${raw}".`);
  }
  return value;
}
