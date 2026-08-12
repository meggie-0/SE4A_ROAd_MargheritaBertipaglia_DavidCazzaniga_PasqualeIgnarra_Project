import type { NotificationType, RobotaxiState } from '@road/shared';

import type { DomainEvent, NotificationDelivery } from './notification.port';

/**
 * Da evento di dominio a notifica da mostrare: la traduzione, in un posto solo.
 *
 * È una funzione pura e sta fuori dal manager perché è l'unica parte della consegna che si possa
 * sbagliare *silenziosamente* — una categoria attribuita male non fa fallire niente, arriva
 * soltanto un messaggio sbagliato al passeggero — e una funzione pura si verifica con una tabella
 * di casi invece che con una socket aperta.
 *
 * La mappa da stato di arrivo a `NotificationType` è la traduzione della Figura 2.10 nell'enum del
 * RASD §2.2.3. Le tre categorie specifiche del RASD (`VEHICLE_ASSIGNED`, `VEHICLE_ARRIVING`,
 * `VEHICLE_ARRIVED`) coprono tre dei quattro momenti che R6 nomina — «vehicle assignment, ETA,
 * arrival at the pickup point, and ride completion» — e il quarto, il completamento, arriva
 * dall'altro soggetto: `Ride` passando a `COMPLETED`.
 *
 * L'**ETA numerico non c'è**, ed è una rinuncia registrata come decisione D46, non una svista:
 * `VEHICLE_ARRIVING` dice che il veicolo è in avvicinamento, non fra quanti minuti arriva. In M5
 * l'unico fornitore di tempi di viaggio è il mock deterministico di M3, e un numero preso da lì e
 * mostrato come promessa al passeggero peggiorerebbe R6 invece di completarlo. Il campo arriva con
 * M7, insieme all'adapter OSRM e alla telemetria che innesca davvero la transizione 4.
 */

/**
 * La categoria di notifica di ogni stato di arrivo, per gli eventi che **riguardano una corsa**.
 *
 * `REBALANCING` e `MAINTENANCE` non ci sono, e non è una dimenticanza: da quegli stati non passa
 * nessuna corsa, quindi nessun passeggero è destinatario e nessuna `Notification` del RASD viene a
 * esistere. Gli eventi corrispondenti raggiungono comunque la dashboard dell'operatore, con
 * `type: null`.
 *
 * **`AVAILABLE` non c'è per una ragione diversa**, e vale la pena leggerla. Un veicolo torna libero
 * in due modi che riguardano una corsa: l'ha portata a termine, o l'ha persa perché è stata
 * annullata (R14). In entrambi i casi la cosa che il passeggero deve sapere non è dove sia finito
 * il veicolo — è che **la sua corsa è finita**, e a dirglielo è l'altro soggetto: `Ride` emette
 * `COMPLETED` o `CANCELLED` nello stesso istante. Dando una categoria anche a questa transizione, il
 * passeggero riceverebbe due push con lo stesso identico testo e la tabella `notification`
 * prenderebbe due righe per un fatto solo. Il ritorno del veicolo fra i disponibili resta un evento
 * di **flotta**, e come tale arriva alla dashboard.
 */
const TYPE_BY_ARRIVAL_STATE: Partial<Record<RobotaxiState, NotificationType>> = {
  ASSIGNED: 'VEHICLE_ASSIGNED',
  ARRIVING: 'VEHICLE_ARRIVING',
  ARRIVED: 'VEHICLE_ARRIVED',
  IN_RIDE: 'RIDE_STATUS_CHANGED',
};

/** Il testo mostrato al passeggero per ogni transizione che riguarda la sua corsa. */
function rideMessage(robotaxiId: string, from: RobotaxiState, to: RobotaxiState): string {
  switch (to) {
    case 'ASSIGNED':
      return `Il robotaxi ${robotaxiId} è stato assegnato alla tua corsa.`;
    case 'ARRIVING':
      return `Il robotaxi ${robotaxiId} sta arrivando al punto di ritiro.`;
    case 'ARRIVED':
      return `Il robotaxi ${robotaxiId} è arrivato al punto di ritiro.`;
    case 'IN_RIDE':
      return 'La corsa è iniziata.';
    default:
      return `Il robotaxi ${robotaxiId} è passato da ${from} a ${to}.`;
  }
}

/**
 * Il testo mostrato all'operatore per una transizione che non è una notifica al passeggero.
 *
 * Comprende il ritorno ad `AVAILABLE` di un veicolo che stava servendo una corsa: per la dashboard
 * è il momento in cui quel veicolo torna disponibile, ed è l'informazione che le serve (R7, G8).
 */
function fleetMessage(robotaxiId: string, from: RobotaxiState, to: RobotaxiState): string {
  switch (to) {
    case 'REBALANCING':
      return `Il robotaxi ${robotaxiId} si sta riposizionando.`;
    case 'MAINTENANCE':
      return `Il robotaxi ${robotaxiId} è entrato in manutenzione.`;
    case 'AVAILABLE':
      switch (from) {
        case 'MAINTENANCE':
          return `Il robotaxi ${robotaxiId} è rientrato dalla manutenzione ed è disponibile.`;
        case 'REBALANCING':
          return `Il robotaxi ${robotaxiId} ha terminato il riposizionamento ed è disponibile.`;
        case 'IN_RIDE':
          return `Il robotaxi ${robotaxiId} ha completato la corsa ed è disponibile.`;
        default:
          return `Il robotaxi ${robotaxiId} è tornato disponibile.`;
      }
    default:
      return `Il robotaxi ${robotaxiId} è passato da ${from} a ${to}.`;
  }
}

/** Il testo di un cambiamento di stato della corsa (RASD §2.2.3, `RideStatus`). */
function rideStatusMessage(status: string): string {
  switch (status) {
    case 'SCHEDULED':
      return 'La tua corsa è confermata.';
    case 'WAITING_FOR_PICKUP':
      return 'Il tuo robotaxi ti sta aspettando al punto di ritiro.';
    case 'IN_PROGRESS':
      return 'La corsa è in corso.';
    case 'COMPLETED':
      return 'La corsa è stata completata.';
    case 'CANCELLED':
      return 'La corsa è stata annullata.';
    default:
      return `La corsa è passata allo stato ${status}.`;
  }
}

/**
 * Traduce l'evento nella notifica da consegnare.
 *
 * Non decide **a chi**: quello dipende da una lettura del database e sta nel manager. Qui si decide
 * solo *che cosa* dice la notifica, il che rende questa funzione totale e priva di I/O.
 */
export function describeEvent(event: DomainEvent): NotificationDelivery {
  if (event.kind === 'RIDE_STATUS_CHANGED') {
    return {
      type: 'RIDE_STATUS_CHANGED',
      message: rideStatusMessage(event.status),
      occurredAt: event.occurredAt,
      rideRequestId: event.rideRequestId,
      robotaxiId: event.robotaxiId,
      robotaxiState: null,
      rideStatus: event.status,
    };
  }

  // Una transizione è una notifica al passeggero se riguarda una corsa **e** lo stato di arrivo ha
  // una categoria del RASD. Tutto il resto è un movimento di flotta.
  const type = event.rideRequestId === null ? null : (TYPE_BY_ARRIVAL_STATE[event.to] ?? null);

  return {
    type,
    message:
      type === null
        ? fleetMessage(event.robotaxiId, event.from, event.to)
        : rideMessage(event.robotaxiId, event.from, event.to),
    occurredAt: event.occurredAt,
    rideRequestId: event.rideRequestId,
    robotaxiId: event.robotaxiId,
    robotaxiState: event.to,
    rideStatus: null,
  };
}
