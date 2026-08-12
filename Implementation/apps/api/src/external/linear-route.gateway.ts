import { Injectable } from '@nestjs/common';
import { haversineKm, type GeoPoint } from '@road/shared';

import type { EtaEstimate, EtaOrigin } from './external-services.port';
import type { RouteLeg } from './route-leg';

/**
 * L'adapter delle mappe **senza rete**: distanza in linea d'aria, corretta e divisa per una
 * velocità media.
 *
 * Nasce in M3, dove MILESTONES.md chiedeva per gli ETA «un mock deterministico», e M7 non lo butta:
 * è la formula che la milestone prescrive come **fallback** dell'adapter OSRM («fallback a stima
 * lineare»), quindi il codice scritto allora sopravvive alla milestone che lo sostituisce. Quando
 * OSRM è irraggiungibile — o non è configurato affatto — è questa classe a rispondere, ed è ciò che
 * il cancello di M7 pretende: «con OSRM irraggiungibile il fallback produce comunque un ETA e
 * nessuna richiesta va persa».
 *
 * Da M7 produce anche **percorsi** e non solo tempi, perché `commandRoute()` ha bisogno di una
 * polyline da far percorrere al veicolo. La sua polyline ha un punto solo, la destinazione: senza
 * una rete stradale la strada più breve fra due punti è il segmento che li unisce. Un veicolo che
 * la segue arriva dove doveva, in un tempo coerente con l'ETA che questa stessa classe ha
 * annunciato — che è la proprietà che conta, perché è quella che il passeggero vede.
 *
 * Determinismo (CLAUDE.md Regola 3): la stima dipende **solo** dalle coordinate. Non legge
 * l'orologio, non estrae numeri casuali, non fa I/O. Due chiamate con gli stessi argomenti danno
 * lo stesso risultato in qualunque momento, che è ciò che rende stabili i test di `allocation`.
 */

/**
 * Velocità media in ambito urbano, km/h.
 *
 * È un'**assunzione del prototipo**, non un dato misurato: il RASD tratta il servizio di mappe
 * come dipendenza esterna e i dati di questa milestone sono simulati. Venti km/h è l'ordine di
 * grandezza della velocità commerciale nel centro di Milano; il valore esatto conta poco, perché
 * una velocità costante non cambia l'**ordinamento** dei candidati — cambia solo la scala dei
 * minuti. È OSRM a introdurre la differenza fra un percorso scorrevole e uno congestionato, ed è
 * con lui collegato che `MinimumEtaStrategy` comincia a scegliere davvero diversamente da
 * `NearestAvailableStrategy`.
 */
const AVERAGE_URBAN_SPEED_KMH = 20;

/**
 * Rapporto fra strada percorsa e distanza in linea d'aria.
 *
 * Un veicolo non vola: segue una maglia di strade. Il fattore di circuità di una città europea
 * compatta sta intorno a 1,3, ed è l'unico modo onesto per non sottostimare sistematicamente ogni
 * attesa comunicata al passeggero. Anche questo è un parametro del modello, sostituito dalla
 * distanza vera del percorso quando OSRM risponde.
 */
const STREET_DETOUR_FACTOR = 1.3;

const MINUTES_PER_HOUR = 60;

@Injectable()
export class LinearRouteGateway {
  getETA(origins: readonly EtaOrigin[], destination: GeoPoint): Promise<readonly EtaEstimate[]> {
    const estimates = origins.map((origin): EtaEstimate => ({
      id: origin.id,
      etaMinutes: this.route(origin.position, destination).durationMinutes,
    }));

    // La stima si sa dare per qualunque coppia di punti, quindi qui l'esito ha sempre la stessa
    // lunghezza dell'ingresso. È una proprietà di *questo* adapter e non della porta: quello di
    // OSRM lascia fuori le origini che il fornitore non sa raggiungere.
    return Promise.resolve(estimates);
  }

  /**
   * Il segmento fra due punti: `distanza × circuità`, percorso a velocità costante.
   *
   * Non è `async` perché non c'è niente da attendere, ed è voluto che si veda: questa è la via
   * d'uscita che deve funzionare quando la rete non c'è.
   */
  route(from: GeoPoint, to: GeoPoint): RouteLeg {
    const distanceKm = haversineKm(from, to) * STREET_DETOUR_FACTOR;
    return {
      waypoints: [to],
      distanceKm,
      durationMinutes: (distanceKm / AVERAGE_URBAN_SPEED_KMH) * MINUTES_PER_HOUR,
    };
  }
}
