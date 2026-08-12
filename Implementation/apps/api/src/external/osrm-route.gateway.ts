import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GeoPoint } from '@road/shared';
import { z } from 'zod';

import { ClockPort } from '../platform/clock.port';

import type { EtaEstimate, EtaOrigin } from './external-services.port';
import { readOsrmSettings, type OsrmSettings } from './external.config';
import { LinearRouteGateway } from './linear-route.gateway';
import type { RouteLeg } from './route-leg';
import { TtlCache } from './ttl-cache';

/**
 * L'adapter **reale** del servizio di mappe: OSRM (MILESTONES.md §M7).
 *
 * Parla due servizi di OSRM e nient'altro: `/table` per i tempi di arrivo di molti veicoli verso un
 * punto — una richiesta sola per l'intero insieme dei candidati, che è la ragione per cui `getETA`
 * nella porta prende una lista — e `/route` per la geometria che il veicolo dovrà percorrere.
 *
 * **È l'unico file del progetto che sa come è fatto OSRM**, ed è la formulazione falsificabile di
 * NFR8 (DD §4.3): «nessun componente fuori da `ExternalServicesGateway` cita un protocollo o un SDK
 * di un fornitore». Fuori da qui non compare un URL, un nome di parametro, un codice di risposta.
 *
 * Tre proprietà, e sono quelle che il cancello di M7 verifica:
 *
 * - **Non configurato è un modo valido di funzionare.** Senza `OSRM_BASE_URL` l'adapter non prova
 *   nemmeno a chiamare: risponde con la stima lineare. È l'installazione che il team usa in locale.
 * - **Irraggiungibile non è un guasto.** Timeout, errore di rete, risposta malformata: si registra
 *   e si ripiega sulla stima lineare. Una richiesta di corsa non va persa perché un servizio di
 *   mappe non ha risposto — sarebbe un passeggero a piedi per un guasto altrui.
 * - **Le risposte si validano prima di crederci.** Lo schema `zod` qui sotto è ciò che trasforma
 *   «il fornitore ha risposto qualcosa» in «il fornitore ha risposto un percorso»: senza, un JSON
 *   inatteso diventerebbe un `NaN` che attraversa il dominio e finisce in un ETA mostrato al
 *   passeggero. Con lo schema diventa un ripiego, che è un esito previsto.
 */

/** I secondi di percorrenza da ciascuna origine verso l'unica destinazione (servizio `/table`). */
const osrmTableSchema = z.object({
  code: z.literal('Ok'),
  durations: z.array(z.array(z.number().nullable())),
});

/** Il percorso del servizio `/route`, con la geometria in GeoJSON: `[lon, lat]`, in quest'ordine. */
const osrmRouteSchema = z.object({
  code: z.literal('Ok'),
  routes: z
    .array(
      z.object({
        distance: z.number(),
        duration: z.number(),
        geometry: z.object({
          coordinates: z.array(z.tuple([z.number(), z.number()])),
        }),
      }),
    )
    .min(1),
});

const SECONDS_PER_MINUTE = 60;
const METERS_PER_KM = 1000;

@Injectable()
export class OsrmRouteGateway {
  private readonly logger = new Logger(OsrmRouteGateway.name);
  private readonly settings: OsrmSettings;

  /** I percorsi già chiesti, per coppia di punti. */
  private readonly legs: TtlCache<RouteLeg>;
  /**
   * I tempi di percorrenza, per coppia di punti.
   *
   * È una cache separata da quella dei percorsi perché il servizio `/table` risponde con i soli
   * tempi: registrarli come percorsi con la geometria vuota vorrebbe dire far percorrere a un
   * veicolo una rotta che nessuno ha calcolato.
   */
  private readonly durations: TtlCache<number>;

  constructor(
    config: ConfigService,
    private readonly clock: ClockPort,
    /** La via d'uscita: la stessa stima lineare che il sistema usava fino a M6. */
    private readonly fallback: LinearRouteGateway,
  ) {
    this.settings = readOsrmSettings(config);
    this.legs = new TtlCache(clock, this.settings.cacheTtlSeconds, this.settings.cacheEntries);
    this.durations = new TtlCache(clock, this.settings.cacheTtlSeconds, this.settings.cacheEntries);
  }

  /** Vero quando `OSRM_BASE_URL` è configurato: senza, l'adapter non tocca la rete. */
  get configured(): boolean {
    return this.settings.baseUrl !== '';
  }

  /**
   * I tempi di arrivo delle origini verso una destinazione comune.
   *
   * Le origini già in cache non entrano nella richiesta: se ci sono tutte, di rete non se ne tocca.
   * Le altre viaggiano in **una sola** richiesta `/table`, perché interrogare il fornitore veicolo
   * per veicolo moltiplicherebbe la latenza di un'allocazione per il numero dei candidati.
   *
   * Un'origine per cui OSRM risponde `null` — nessun percorso, punto irraggiungibile — **non
   * compare nell'esito**, come la porta prescrive: `MinimumEtaStrategy` deve poter distinguere «è
   * lontanissimo» da «di questo veicolo non so nulla», e il secondo non è idoneo.
   */
  async getETA(
    origins: readonly EtaOrigin[],
    destination: GeoPoint,
  ): Promise<readonly EtaEstimate[]> {
    if (origins.length === 0) return [];
    if (!this.configured) return this.fallback.getETA(origins, destination);

    const estimates: EtaEstimate[] = [];
    const missing: EtaOrigin[] = [];

    for (const origin of origins) {
      const cached = this.durations.get(pairKey(origin.position, destination));
      if (cached === null) missing.push(origin);
      else estimates.push({ id: origin.id, etaMinutes: cached });
    }

    if (missing.length > 0) {
      const fresh = await this.requestDurations(missing, destination);
      estimates.push(...fresh);
    }

    return estimates;
  }

  /**
   * Il percorso da `from` a `to`, con la geometria che il veicolo seguirà.
   *
   * Il ripiego non restituisce un errore né una rotta vuota: restituisce il segmento fra i due
   * punti. Un veicolo che lo segue arriva dove doveva — meno fedelmente, ma arriva — e questa è la
   * differenza fra un fornitore assente e un sistema fermo.
   */
  async route(from: GeoPoint, to: GeoPoint): Promise<RouteLeg> {
    if (!this.configured) return this.fallback.route(from, to);

    const key = pairKey(from, to);
    const cached = this.legs.get(key);
    if (cached !== null) return cached;

    const response = await this.get(
      `/route/v1/driving/${coordinate(from)};${coordinate(to)}?overview=full&geometries=geojson`,
      osrmRouteSchema,
    );
    if (response === null) return this.fallback.route(from, to);

    // Lo schema pretende almeno un percorso: il primo è quello che OSRM considera migliore.
    const best = response.routes[0] as z.infer<typeof osrmRouteSchema>['routes'][number];
    const leg: RouteLeg = {
      // GeoJSON scrive `[lon, lat]`. Invertirli qui, una volta, evita che l'inversione viaggi nel
      // resto del sistema — dove un veicolo finirebbe in mezzo al Mediterraneo senza che nulla
      // sembri sbagliato.
      waypoints: best.geometry.coordinates.map(([lon, lat]) => ({ lat, lon })),
      distanceKm: best.distance / METERS_PER_KM,
      durationMinutes: best.duration / SECONDS_PER_MINUTE,
    };

    // Una geometria vuota non è un percorso: meglio il segmento, che almeno porta il veicolo a
    // destinazione. Non si registra in cache, perché non c'è niente da ricordare.
    if (leg.waypoints.length === 0) return this.fallback.route(from, to);

    this.legs.set(key, leg);
    this.durations.set(key, leg.durationMinutes);
    return leg;
  }

  /**
   * Una richiesta `/table` per le origini non ancora note.
   *
   * Se il fornitore non risponde, **le origini mancanti passano alla stima lineare** invece di
   * sparire dall'esito: sparire significherebbe «di questi veicoli non so nulla», cioè renderli
   * tutti inidonei, e un servizio di mappe irraggiungibile lascerebbe il passeggero a piedi. È il
   * caso che il cancello di M7 verifica.
   */
  private async requestDurations(
    origins: readonly EtaOrigin[],
    destination: GeoPoint,
  ): Promise<readonly EtaEstimate[]> {
    const points = [...origins.map((origin) => origin.position), destination];
    const sources = origins.map((_origin, index) => index).join(';');

    const response = await this.get(
      `/table/v1/driving/${points.map(coordinate).join(';')}` +
        `?sources=${sources}&destinations=${origins.length}&annotations=duration`,
      osrmTableSchema,
    );
    if (response === null) return this.fallback.getETA(origins, destination);

    const estimates: EtaEstimate[] = [];
    for (const [index, origin] of origins.entries()) {
      const seconds = response.durations[index]?.[0];
      // `null` da OSRM significa «non c'è un percorso»: l'origine resta fuori dall'esito.
      if (seconds === undefined || seconds === null) continue;

      const etaMinutes = seconds / SECONDS_PER_MINUTE;
      this.durations.set(pairKey(origin.position, destination), etaMinutes);
      estimates.push({ id: origin.id, etaMinutes });
    }
    return estimates;
  }

  /**
   * Una `GET` al fornitore, validata. `null` significa «non lo so»: chi chiama ripiega.
   *
   * Il timeout è un `AbortSignal`, non un timer del dominio: senza, una richiesta appesa terrebbe
   * ferma un'allocazione fino al timeout di sistema, che si misura in minuti.
   */
  private async get<S extends z.ZodType>(path: string, schema: S): Promise<z.infer<S> | null> {
    try {
      const response = await fetch(`${this.settings.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.settings.timeoutMs),
      });
      if (!response.ok) {
        this.logger.warn(
          `OSRM ha risposto ${response.status} su ${path}: si usa la stima lineare.`,
        );
        return null;
      }

      const parsed = schema.safeParse(await response.json());
      if (!parsed.success) {
        this.logger.warn(`Risposta OSRM inattesa su ${path}: si usa la stima lineare.`);
        return null;
      }
      return parsed.data;
    } catch (error) {
      // Rete assente, timeout, DNS: tutte la stessa cosa dal punto di vista di chi chiede un ETA.
      this.logger.warn(
        `OSRM irraggiungibile su ${path} (${describe(error)}): si usa la stima lineare.`,
      );
      return null;
    }
  }
}

/** `lon,lat`, che è l'ordine con cui OSRM scrive le coordinate nel percorso dell'URL. */
function coordinate(point: GeoPoint): string {
  return `${point.lon},${point.lat}`;
}

/**
 * La chiave di cache di una coppia di punti, arrotondata a cinque decimali.
 *
 * Cinque decimali sono circa un metro: due richieste che differiscono di meno non descrivono due
 * percorsi diversi, e senza arrotondamento la cache non avrebbe mai un successo — ogni veicolo si
 * muove di frazioni di grado a ogni tick.
 */
function pairKey(from: GeoPoint, to: GeoPoint): string {
  return `${round(from)}>${round(to)}`;
}

function round(point: GeoPoint): string {
  return `${point.lat.toFixed(5)},${point.lon.toFixed(5)}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
