/**
 * Ciò che il veicolo deve sapere di una corsa per accettarla (transizioni 3 e 10 della Figura 2.10,
 * la cui azione è `storeRide()`).
 *
 * È volutamente minima. Il DD §2.3.2 scrive `assignRide(request: RideRequest)`, ma `RideRequest`
 * come oggetto di dominio nasce in M4 insieme a `RideRequestManager`: il veicolo ha bisogno
 * dell'identificatore della richiesta e di nient'altro, e un tipo più grande obbligherebbe M2 a
 * inventare la forma che M4 deve ancora decidere. Quando `rides` esisterà, costruirà un
 * `RideAssignment` dal proprio record senza che `fleet` debba cambiare.
 */
export interface RideAssignment {
  readonly rideRequestId: string;
}
