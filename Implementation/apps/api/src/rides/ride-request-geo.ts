import type { GeoPoint } from '@road/shared';

import type { RideRequestRecord } from '../persistence/persistence.port';

/**
 * Dalle colonne di una richiesta persistita ai due punti che la descrivono.
 *
 * Le coordinate stanno in colonne separate perché nel RASD §2.2.1 `Location` è un valore e non
 * un'entità con identità propria; queste due funzioni sono la conversione inversa, e servono a chi
 * la richiesta la **rilegge** invece di riceverla — cioè all'attivatore.
 *
 * Stanno in un file a sé e non su `RideRequestManager` per una ragione di dipendenze interne al
 * modulo: sono funzioni pure che con il coordinatore non hanno rapporto, e importarle da lì
 * legherebbe l'attivatore al manager per due conversioni di coordinate.
 */

export function pickupOf(request: RideRequestRecord): GeoPoint {
  return { lat: request.pickupLat, lon: request.pickupLon };
}

export function destinationOf(request: RideRequestRecord): GeoPoint {
  return { lat: request.destinationLat, lon: request.destinationLon };
}
