import { Injectable } from '@nestjs/common';
import type { RideStatus } from '@road/shared';

import { NotificationPort } from '../notifications/notification.port';
import {
  PersistencePort,
  type RideRecord,
  type RideRequestRecord,
} from '../persistence/persistence.port';

import { Ride } from './ride';

/**
 * Il registro delle corse: crea la `Ride`, ne fa avanzare lo stato e la notifica.
 *
 * Sta a `Ride` come `FleetMonitor` sta a `Robotaxi`, e la simmetria è voluta — è la stessa disciplina
 * applicata al secondo soggetto dell'Observer:
 *
 * 1. legge il record e ricostruisce l'oggetto di dominio;
 * 2. gli **registra sopra l'unico observer**, il `NotificationManager` (DD §2.3.3);
 * 3. gli chiede il cambiamento;
 * 4. lo **persiste**;
 * 5. solo allora notifica.
 *
 * L'ordine fra 4 e 5 è la parte che conta. Notificare prima di scrivere significa raccontare al
 * passeggero un cambiamento che potrebbe non essere avvenuto; e una notifica, a differenza di una
 * scrittura, non si può disfare. Vale qui come in `FleetMonitor`.
 *
 * È interno a `rides`: non esce da nessuna porta. Chi sta fuori vede le corse avanzare attraverso
 * `RideLifecyclePort`, e le notifiche arrivare dal canale push.
 */
@Injectable()
export class RideJournal {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly notifications: NotificationPort,
  ) {}

  /**
   * Apre la corsa generata da una richiesta accettata (RASD §2.2.1, `1 --> 0..1`).
   *
   * Nasce `SCHEDULED` in entrambi i cammini, immediato e anticipato, ma con un `robotaxiId` diverso:
   * la corsa immediata ha già il suo veicolo, la prenotazione ne ha uno solo *riservato* e lo saprà
   * all'attivazione (decisione D9). Chiamare assegnato un veicolo riservato prometterebbe al
   * passeggero più di quanto il sistema garantisca.
   */
  async open(request: RideRequestRecord, robotaxiId: string | null, at: Date): Promise<RideRecord> {
    const record = await this.persistence.create('ride', {
      rideRequestId: request.id,
      passengerId: request.passengerId,
      robotaxiId,
      status: 'SCHEDULED',
      pickupLat: request.pickupLat,
      pickupLon: request.pickupLon,
      destinationLat: request.destinationLat,
      destinationLon: request.destinationLon,
      startedAt: null,
      endedAt: null,
      createdAt: at,
    });

    await this.notify(record, at);
    return record;
  }

  /**
   * Scrive sulla corsa il veicolo che la servirà, senza cambiarne lo stato.
   *
   * È il passo dell'attivazione di una prenotazione: la corsa era e resta `SCHEDULED` — il patto col
   * passeggero non è cambiato — ma ora si sa **chi** la farà. Nessuna notifica parte di qui: quella
   * la manda il veicolo passando ad `ASSIGNED`, ed è la stessa informazione. Mandarne due direbbe
   * due volte la stessa cosa.
   */
  async attachRobotaxi(rideRequestId: string, robotaxiId: string | null): Promise<void> {
    const ride = await this.rideOf(rideRequestId);
    if (ride === undefined) return;
    await this.persistence.update('ride', ride.id, { robotaxiId });
  }

  /**
   * Porta la corsa a un nuovo stato e lo notifica.
   *
   * `startedAt` ed `endedAt` seguono lo stato invece di essere argomenti: sono le due marche
   * temporali che il RASD §2.2.3 dà a `Ride`, e il momento in cui valorizzarle è definito dallo
   * stato in cui si entra. Lasciarle decidere al chiamante avrebbe reso possibile una corsa
   * `COMPLETED` senza fine e una `IN_PROGRESS` senza inizio, che il `CHECK` in migrazione rifiuta
   * comunque — ma è meglio che il caso non si presenti.
   *
   * Restituisce `null` se la richiesta non ha una corsa: le richieste rifiutate non ne generano
   * (RASD §2.2.1), e chiedere di far avanzare la corsa di una di quelle non è un errore, è un
   * non-evento.
   */
  async advance(rideRequestId: string, status: RideStatus, at: Date): Promise<RideRecord | null> {
    const current = await this.rideOf(rideRequestId);
    if (current === undefined) return null;

    const ride = new Ride(current);
    ride.registerObserver(this.notifications);
    ride.updateStatus(status);

    const updated = await this.persistence.update('ride', current.id, {
      status: ride.currentStatus,
      ...(status === 'IN_PROGRESS' ? { startedAt: at } : {}),
      ...(status === 'COMPLETED' || status === 'CANCELLED' ? { endedAt: at } : {}),
    });

    // Persistito, poi notificato: si racconta ciò che è successo.
    await ride.notifyObservers(ride.statusChangedEvent(at));
    return updated;
  }

  /** La corsa generata da una richiesta, se esiste. `ride_request_id` è unica in schema. */
  async find(rideRequestId: string): Promise<RideRecord | null> {
    return (await this.rideOf(rideRequestId)) ?? null;
  }

  private async rideOf(rideRequestId: string): Promise<RideRecord | undefined> {
    const [ride] = await this.persistence.find('ride', {
      where: { rideRequestId },
      limit: 1,
    });
    return ride;
  }

  /** La notifica dell'apertura: la corsa appena creata annuncia il proprio stato iniziale. */
  private async notify(record: RideRecord, at: Date): Promise<void> {
    const ride = new Ride(record);
    ride.registerObserver(this.notifications);
    await ride.notifyObservers(ride.statusChangedEvent(at));
  }
}
