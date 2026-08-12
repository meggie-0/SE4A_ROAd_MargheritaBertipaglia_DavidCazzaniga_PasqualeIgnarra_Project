import type { RideStatus } from '@road/shared';

import type {
  DomainEvent,
  Observer,
  RideStatusChangedEvent,
  Subject,
} from '../notifications/notification.port';
import type { RideRecord } from '../persistence/persistence.port';

/**
 * La **corsa**: il secondo soggetto dell'Observer (DD §2.3.3, Figura 2.4).
 *
 * `Robotaxi` racconta dove sta il veicolo, `Ride` a che punto è il viaggio, e il RASD §2.2.1 le
 * tiene separate apposta — «An accepted Ride Request can generate one Ride». Sono due letture della
 * stessa progressione, e servono entrambe: `ARRIVED` dice che il veicolo è fermo al punto di
 * ritiro, `WAITING_FOR_PICKUP` dice che sta aspettando **te**.
 *
 * Come `Robotaxi`, è un oggetto di **memoria**: `RideJournal` lo costruisce dal record, gli registra
 * l'observer, gli chiede il cambiamento di stato e ne persiste l'esito. La lista di observer vive
 * quanto l'operazione, e l'unico elemento che ci finisce dentro è il `NotificationManager`
 * (decisione D7).
 *
 * Non ha una macchina a stati con classi come il veicolo, e non è una dimenticanza: il DD §2.6.3
 * assegna il pattern State al `Robotaxi` e a nessun altro. `RideStatus` qui segue la progressione
 * del veicolo, che è già quella a essere sorvegliata da sette classi di stato; duplicare la stessa
 * macchina su due oggetti avrebbe creato due verità da tenere allineate.
 */
export class Ride implements Subject {
  private readonly observers: Observer[] = [];
  private status: RideStatus;

  constructor(private readonly record: RideRecord) {
    this.status = record.status;
  }

  get id(): string {
    return this.record.id;
  }

  get currentStatus(): RideStatus {
    return this.status;
  }

  /** `updateStatus(status)` della Figura 2.4: cambia lo stato, non lo persiste e non notifica. */
  updateStatus(status: RideStatus): void {
    this.status = status;
  }

  // -------------------------------------------------------------------------------------------
  // `Subject` (DD §2.3.3, Figura 2.4)
  // -------------------------------------------------------------------------------------------

  registerObserver(observer: Observer): void {
    if (!this.observers.includes(observer)) this.observers.push(observer);
  }

  removeObserver(observer: Observer): void {
    const at = this.observers.indexOf(observer);
    if (at !== -1) this.observers.splice(at, 1);
  }

  async notifyObservers(event: DomainEvent): Promise<void> {
    for (const observer of this.observers) await observer.update(event);
  }

  /**
   * L'evento che descrive lo stato corrente della corsa.
   *
   * Porta `passengerId` già risolto perché la corsa il proprio passeggero lo conosce — è una sua
   * colonna — e chiedere al `NotificationManager` di ricavarlo con una lettura sarebbe fargli
   * scoprire ciò che il soggetto ha già in mano.
   */
  statusChangedEvent(occurredAt: Date): RideStatusChangedEvent {
    return {
      kind: 'RIDE_STATUS_CHANGED',
      occurredAt,
      rideId: this.record.id,
      rideRequestId: this.record.rideRequestId,
      passengerId: this.record.passengerId,
      robotaxiId: this.record.robotaxiId,
      status: this.status,
    };
  }
}
