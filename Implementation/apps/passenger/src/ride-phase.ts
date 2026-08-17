import type { NotificationPush, RideRequestResponse } from '@road/shared';

/**
 * La progressione che il passeggero vede (DD §3.1).
 *
 * «After the request, the same screen turns into a live status view that follows the ride through
 * its states (searching, assigned, arriving, arrived, in ride), driven by the Observer
 * notifications»: questo file è quella frase, tradotta in una funzione pura.
 *
 * **Non è una terza macchina a stati.** Le macchine sono due e stanno nel backend — quella del
 * veicolo (DD §2.6.3, Figura 2.10) e quella della corsa (`RideStatus`, RASD §2.2.3) — e questa è la
 * loro *proiezione* su ciò che interessa a chi aspetta un'auto. Nessuna transizione viene decisa
 * qui: si legge l'ultima notizia ricevuta e le si dà un nome. Se decidesse, sarebbe la macchina a
 * stati scritta una terza volta, e divergerebbe (CLAUDE.md Regola 2).
 */

export const RIDE_PHASES = [
  'searching',
  'assigned',
  'arriving',
  'arrived',
  'in_ride',
  'completed',
  'cancelled',
  'rejected',
] as const;
export type RidePhase = (typeof RIDE_PHASES)[number];

/** L'etichetta mostrata a schermo, in italiano come il resto dell'interfaccia. */
export const PHASE_LABELS: Record<RidePhase, string> = {
  searching: 'Cerchiamo un robotaxi per te',
  assigned: 'Robotaxi assegnato',
  arriving: 'Il robotaxi sta arrivando',
  arrived: 'Il robotaxi è al punto di ritiro',
  in_ride: 'Corsa in corso',
  completed: 'Corsa completata',
  cancelled: 'Corsa annullata',
  rejected: 'Nessun robotaxi disponibile',
};

export interface RideView {
  readonly phase: RidePhase;
  readonly robotaxiId: string | null;
  /** I minuti che mancano al ritiro, quando il backend li conosce (R6, decisione D46). */
  readonly etaMinutes: number | null;
  /** L'ultimo messaggio ricevuto dal canale push, già pronto da mostrare. */
  readonly lastMessage: string | null;
}

/**
 * La fase di partenza, dalla risposta alla richiesta.
 *
 * Una prenotazione anticipata accettata non ha ancora un veicolo — lo avrà all'attivazione,
 * decisione D9 — quindi resta in `searching` finché la prima notifica non dice altro: chiamarla
 * `assigned` prometterebbe al passeggero più di quanto il sistema garantisca.
 */
export function initialView(request: RideRequestResponse): RideView {
  const phase: RidePhase =
    request.status === 'CANCELLED'
      ? 'cancelled'
      : request.status === 'COMPLETED'
        ? 'completed'
        : request.status === 'REJECTED'
          ? 'rejected'
          : request.assignedRobotaxiId !== null
            ? 'assigned'
            : 'searching';

  return {
    phase,
    robotaxiId: request.assignedRobotaxiId,
    etaMinutes: null,
    lastMessage: null,
  };
}

/**
 * La vista aggiornata con una notifica.
 *
 * L'ordine dei due controlli è il punto: lo stato della **corsa** ha la precedenza su quello del
 * veicolo, perché è quello che descrive il servizio ricevuto. Un veicolo che torna `AVAILABLE` alla
 * fine di una corsa non significa «stiamo cercando un robotaxi»; significa che la corsa è finita, e
 * a dirlo è `rideStatus`.
 */
export function applyNotification(current: RideView, event: NotificationPush): RideView {
  const phase = phaseOf(event) ?? current.phase;

  return {
    phase,
    robotaxiId: event.robotaxiId ?? current.robotaxiId,
    // L'ETA vale finché il veicolo sta arrivando: mostrarlo ancora a passeggero a bordo direbbe
    // quanto ci avrebbe messo ad arrivare dove è già.
    etaMinutes: phase === 'arriving' ? (event.etaMinutes ?? current.etaMinutes) : null,
    lastMessage: event.message,
  };
}

function phaseOf(event: NotificationPush): RidePhase | null {
  switch (event.rideStatus) {
    case 'COMPLETED':
      return 'completed';
    case 'CANCELLED':
      return 'cancelled';
    case 'IN_PROGRESS':
      return 'in_ride';
    case 'WAITING_FOR_PICKUP':
      return 'arrived';
    case 'SCHEDULED':
      return 'assigned';
    case null:
      break;
  }

  switch (event.robotaxiState) {
    case 'ASSIGNED':
      return 'assigned';
    case 'ARRIVING':
      return 'arriving';
    case 'ARRIVED':
      return 'arrived';
    case 'IN_RIDE':
      return 'in_ride';
    // `AVAILABLE`, `REBALANCING` e `MAINTENANCE` non descrivono nessuna fase della *mia* corsa: un
    // veicolo può tornare libero perché la corsa è finita, e a dirlo è stato `rideStatus` qui sopra.
    case 'AVAILABLE':
    case 'REBALANCING':
    case 'MAINTENANCE':
    case null:
      return null;
  }
}
