import type { ConfigService } from '@nestjs/config';
import { MILAN_ZONES, TRAFFIC_LEVELS, type TrafficLevel } from '@road/shared';
import { DEFAULT_SIMULATOR_SETTINGS, type FleetSimulatorSettings } from '@road/simulator';

import type { TrafficTimeFactors } from './traffic-slowdown';

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
 * I parametri del simulatore di flotta, che sono quelli del pacchetto.
 *
 * La velocità è la stessa assunzione dichiarata che regge la stima lineare degli ETA: cambiandola
 * cambia quanti tick servono per arrivare, non chi arriva prima.
 */
export type SimulatorSettings = FleetSimulatorSettings;

/**
 * I default **sono quelli del pacchetto**, non una seconda copia degli stessi numeri.
 *
 * Prima erano scritti due volte, qui e in `DEFAULT_SIMULATOR_SETTINGS`, e finché erano due costanti
 * indipendenti la duplicazione era innocua solo per coincidenza: da quando il passo del simulatore
 * si deriva dalla cadenza con cui il sistema guarda la flotta, una copia rimasta indietro farebbe
 * avanzare il mondo più in fretta di quanto lo si osserva. L'import è lecito perché questo file sta
 * in `src/external/`, l'unico posto da cui `@road/simulator` si raggiunge (HARNESS.md §3).
 */
export const DEFAULT_SIMULATOR_SPEED_KMH = DEFAULT_SIMULATOR_SETTINGS.speedKmH;
export const DEFAULT_SIMULATOR_TICK_SECONDS = DEFAULT_SIMULATOR_SETTINGS.tickSeconds;

export function readSimulatorSettings(config: ConfigService): SimulatorSettings {
  return {
    speedKmH: positiveInteger(config, 'SIMULATOR_SPEED_KMH', DEFAULT_SIMULATOR_SPEED_KMH),
    tickSeconds: positiveInteger(config, 'SIMULATOR_TICK_SECONDS', DEFAULT_SIMULATOR_TICK_SECONDS),
  };
}

/**
 * Quanto costa un chilometro a ciascun livello di traffico, da `TRAFFIC_TIME_FACTORS` (D79).
 *
 * La forma è quella di `TRAFFIC_SCRIPT`, livello e valore: `MEDIUM:1.6,HIGH:3` vuol dire che dove il
 * traffico è medio un chilometro costa il tempo di 1,6, dove è alto quello di tre. Un livello non
 * nominato vale uno. **Assente o vuota restituisce `null`**, cioè nessun rallentamento da nessuna
 * parte: è il default, ed è ciò che tiene intatto il comportamento di un'installazione che non sa
 * niente di questa variabile.
 *
 * Un valore malformato, o minore di uno, ferma l'avvio come fanno gli interi qui sotto. Un fattore
 * sotto uno direbbe che il traffico **accelera** i veicoli, e nessuno lo scrive apposta.
 */
export function readTrafficTimeFactors(config: ConfigService): TrafficTimeFactors | null {
  const raw = config.get<string>('TRAFFIC_TIME_FACTORS');
  if (raw === undefined || raw.trim() === '') return null;

  const factors: Record<TrafficLevel, number> = { LOW: 1, MEDIUM: 1, HIGH: 1 };
  for (const entry of raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')) {
    const [levelPart = '', valuePart = ''] = entry.split(':');
    const level = levelPart.trim().toUpperCase();
    const value = Number(valuePart.trim());
    if (
      !(TRAFFIC_LEVELS as readonly string[]).includes(level) ||
      !Number.isFinite(value) ||
      value < 1
    ) {
      throw new Error(
        `TRAFFIC_TIME_FACTORS: «${entry}» non è un livello di traffico seguito da un fattore ≥ 1.`,
      );
    }
    factors[level as TrafficLevel] = value;
  }
  return factors;
}

/**
 * Le zone del **centro**, da `TRAFFIC_CENTRE_ZONES` (D79): quelle in cui vale la tabella del
 * traffico scriptato, mentre il resto della città resta scorrevole.
 *
 * Assente o vuota restituisce `null`, e la tabella vale per tutta la città — il comportamento della
 * D76. Una zona che non esiste ferma l'avvio: un refuso nel nome farebbe restare scorrevole proprio
 * la zona che la dimostrazione vuole congestionata, senza un segnale.
 */
export function readCentreZones(config: ConfigService): ReadonlySet<string> | null {
  const raw = config.get<string>('TRAFFIC_CENTRE_ZONES');
  if (raw === undefined || raw.trim() === '') return null;

  const known = new Set(MILAN_ZONES.map((zone) => zone.id));
  const zones = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  for (const zone of zones) {
    if (!known.has(zone)) throw new Error(`TRAFFIC_CENTRE_ZONES: la zona «${zone}» non esiste.`);
  }
  return new Set(zones);
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
