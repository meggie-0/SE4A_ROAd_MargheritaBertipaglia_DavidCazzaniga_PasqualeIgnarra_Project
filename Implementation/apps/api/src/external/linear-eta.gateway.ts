import { Injectable } from '@nestjs/common';
import { haversineKm, type GeoPoint } from '@road/shared';

import { ExternalServicesPort, type EtaEstimate, type EtaOrigin } from './external-services.port';

/**
 * L'adapter dei servizi esterni di M3: una **stima lineare**, deterministica e senza rete.
 *
 * MILESTONES.md §M3 chiede per gli ETA «un mock deterministico». Questo non è un doppio da test
 * lasciato in produzione per pigrizia: è esattamente la formula che M7 prescrive come *fallback*
 * dell'adapter OSRM («fallback a stima lineare»), quindi il codice che nasce qui sopravvive alla
 * milestone che lo sostituisce, invece di essere buttato. Quando `OsrmEtaGateway` arriverà, questa
 * classe resterà come sua via d'uscita quando il fornitore è irraggiungibile — che è il caso che
 * il cancello di M7 pretende: «con OSRM irraggiungibile il fallback produce comunque un ETA».
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
 * minuti. È OSRM, in M7, a introdurre la differenza fra un percorso scorrevole e uno congestionato,
 * ed è allora che `MinimumEtaStrategy` comincia a scegliere davvero diversamente da
 * `NearestAvailableStrategy`.
 */
const AVERAGE_URBAN_SPEED_KMH = 20;

/**
 * Rapporto fra strada percorsa e distanza in linea d'aria.
 *
 * Un veicolo non vola: segue una maglia di strade. Il fattore di circuità di una città europea
 * compatta sta intorno a 1,3, ed è l'unico modo onesto per non sottostimare sistematicamente ogni
 * attesa comunicata al passeggero. Anche questo è un parametro del modello, sostituito in M7 dalla
 * distanza vera del percorso.
 */
const STREET_DETOUR_FACTOR = 1.3;

const MINUTES_PER_HOUR = 60;

@Injectable()
export class LinearEtaGateway extends ExternalServicesPort {
  getETA(origins: readonly EtaOrigin[], destination: GeoPoint): Promise<readonly EtaEstimate[]> {
    const estimates = origins.map((origin): EtaEstimate => ({
      id: origin.id,
      etaMinutes: etaMinutesBetween(origin.position, destination),
    }));

    // La stima si sa dare per qualunque coppia di punti, quindi qui l'esito ha sempre la stessa
    // lunghezza dell'ingresso. È una proprietà di *questo* adapter e non della porta: quello di
    // M7 lascerà fuori le origini che il fornitore non sa raggiungere.
    return Promise.resolve(estimates);
  }
}

/**
 * `distanza in linea d'aria × circuità ÷ velocità media`, in minuti. Funzione pura.
 *
 * Non è esportata: questo file non è una porta, quindi nessuno fuori da `external/` potrebbe
 * importarla senza violare i confini fra moduli. Chi ha bisogno di un ETA passa da `getETA()`.
 */
function etaMinutesBetween(from: GeoPoint, to: GeoPoint): number {
  const streetKm = haversineKm(from, to) * STREET_DETOUR_FACTOR;
  return (streetKm / AVERAGE_URBAN_SPEED_KMH) * MINUTES_PER_HOUR;
}
