import { z } from 'zod';

import { RIDE_REQUEST_KINDS, RIDE_REQUEST_STATUSES } from './domain.js';
import type { GeoPoint } from './geo.js';

/**
 * Il contratto pubblico delle richieste di corsa (RASD R3, R4, R14; G2, G3; DD §2.4).
 *
 * Sta in `packages/shared` per la stessa ragione degli altri contratti: gli schemi sono la sorgente
 * unica di verità per DTO ed enum (HARNESS.md §4). Il backend li usa per validare ciò che riceve e
 * i suoi DTO li `implements`, così il compilatore fallisce se contratto pubblicato e tipi condivisi
 * divergono; l'app passeggero di M8 li userà per validare ciò che riceve senza importare una riga
 * da `apps/api`.
 *
 * Le tre operazioni sono quelle di `IRideRequestService` (DD §2.2): richiesta immediata,
 * prenotazione anticipata, annullamento. Non c'è un'operazione di lettura dell'elenco delle proprie
 * corse: nessun requisito di M4 la chiede, e la porta non cresce per comodità.
 */

/**
 * Un punto sulla mappa, validato ai limiti del sistema di coordinate.
 *
 * I limiti sono quelli del globo e non quelli di Milano: restringere alla città sarebbe un vincolo
 * di dominio che né il RASD né il DD enunciano, e trasformerebbe un prototipo trasferibile in uno
 * legato a una bounding box scritta a mano. La zona a cui un punto appartiene la decide comunque
 * il centroide più vicino (decisione D10), che è definito ovunque.
 */
/*
 * L'annotazione `z.ZodType<GeoPoint>` non è decorativa: **lega lo schema al tipo di dominio**.
 * `geo.ts` dichiara già `GeoPoint`, e due definizioni strutturalmente identiche ma senza rapporto
 * fra loro divergono alla prima che qualcuno tocca — un campo aggiunto qui e non là passerebbe
 * inosservato. Così il compilatore fallisce.
 */
export const geoPointSchema: z.ZodType<GeoPoint> = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
});
export type GeoPointPayload = z.infer<typeof geoPointSchema>;

/** L'indirizzo leggibile del punto, facoltativo: il sistema lavora sulle coordinate. */
const addressSchema = z.string().trim().min(1).max(255);

/**
 * `POST /rides/immediate` — R3, G2.
 *
 * Non c'è `passengerId`: chi richiede la corsa è chi porta il token, e accettarlo dal corpo
 * permetterebbe a un passeggero di richiedere corse a nome di un altro.
 */
export const submitImmediateRideRequestSchema = z.object({
  pickup: geoPointSchema,
  pickupAddress: addressSchema.optional(),
  destination: geoPointSchema,
  destinationAddress: addressSchema.optional(),
});
export type SubmitImmediateRideRequest = z.infer<typeof submitImmediateRideRequestSchema>;

/**
 * `POST /rides/advance` — R4, G3.
 *
 * `scheduledPickup` è un istante ISO 8601 con fuso orario. Che sia nel **futuro** non lo controlla
 * questo schema e non è una dimenticanza: «futuro» è una relazione con l'adesso, e l'adesso in
 * questo sistema viene da `ClockPort` (CLAUDE.md Regola 3). Un controllo qui userebbe l'orologio di
 * sistema e renderebbe lo schema non riproducibile; il confronto lo fa `RideRequestManager`, che
 * l'orologio ce l'ha iniettato.
 */
export const submitAdvanceBookingRequestSchema = submitImmediateRideRequestSchema.extend({
  scheduledPickup: z.iso.datetime({ offset: true }),
});
export type SubmitAdvanceBookingRequest = z.infer<typeof submitAdvanceBookingRequestSchema>;

/**
 * La richiesta di corsa come la vedono i client, in risposta a tutte e tre le operazioni.
 *
 * `status` è la sola cosa che il client deve guardare per sapere com'è andata: una richiesta senza
 * veicolo idoneo torna con `REJECTED` e non con un errore HTTP, perché il rifiuto è un esito
 * previsto del dominio (RASD Figura 3.1, ramo `[request rejected]`) e non un guasto della chiamata.
 *
 * `assignedRobotaxiId` è valorizzato quando un veicolo è stato **assegnato**. Per una prenotazione
 * anticipata accettata resta `null` fino all'attivazione (decisione D9): fino a quel momento il
 * veicolo è *riservato*, e chiamarlo assegnato prometterebbe al passeggero più di quanto il sistema
 * garantisca — se nel frattempo finisce in manutenzione, all'attivazione ne arriva un altro.
 */
export const rideRequestResponseSchema = z.object({
  id: z.uuid(),
  kind: z.enum(RIDE_REQUEST_KINDS),
  status: z.enum(RIDE_REQUEST_STATUSES),
  pickup: geoPointSchema,
  pickupAddress: z.string().nullable(),
  destination: geoPointSchema,
  destinationAddress: z.string().nullable(),
  assignedRobotaxiId: z.string().nullable(),
  /** L'orario concordato, presente solo per le prenotazioni anticipate. */
  scheduledPickup: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type RideRequestResponse = z.infer<typeof rideRequestResponseSchema>;

/**
 * `GET /rides/:rideRequestId/vehicle` — dove si trova il veicolo della propria corsa (M8, R3, R6;
 * decisione D69).
 *
 * **Porta la posizione e non lo stato**, ed è la parte del contratto da non allargare per comodità.
 * Lo stato del veicolo e quello della corsa sono ciò che R6 promette al passeggero e viaggiano sul
 * canale push: se li portasse anche questa lettura, un client potrebbe scoprire una transizione
 * interrogando invece di ascoltando, e la proprietà con cui il DD §4.3 dichiara soddisfatto NFR2 —
 * «a state change reaches a connected client over the push channel **without the client polling**»
 * — smetterebbe di essere verificabile: nessun test potrebbe più distinguere le due vie.
 *
 * `vehicle` è **annullabile** perché un veicolo non c'è sempre: una prenotazione accettata è
 * riservata e non assegnata fino all'attivazione (decisione D9), e una richiesta rifiutata o
 * annullata non ne ha mai avuto uno. Nessuno dei tre casi è un errore, quindi nessuno è un 404.
 *
 * L'unico istante nella risposta è **dentro** `vehicle`, ed è quello in cui la telemetria ha
 * scritto quella posizione. Non c'è un istante della lettura al livello esterno di proposito:
 * quando un veicolo non c'è, non ci sarebbe niente da datare e bisognerebbe inventare un valore.
 */
export const assignedVehicleResponseSchema = z.object({
  vehicle: z
    .object({
      robotaxiId: z.string().min(1),
      position: geoPointSchema,
      /** Quando la telemetria ha scritto quella posizione (M7), non quando l'hai chiesta. */
      updatedAt: z.iso.datetime(),
    })
    .nullable(),
});
export type AssignedVehicleResponse = z.infer<typeof assignedVehicleResponseSchema>;
