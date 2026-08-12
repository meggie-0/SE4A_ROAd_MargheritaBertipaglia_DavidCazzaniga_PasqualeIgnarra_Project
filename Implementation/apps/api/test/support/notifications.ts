import { Test, type TestingModule } from '@nestjs/testing';
import type { NotificationPush } from '@road/shared';

import {
  NotificationPort,
  type NotificationDelivery,
} from '../../src/notifications/notification.port';
import { NotificationsModule } from '../../src/notifications/notifications.module';
import {
  NotificationSessionPort,
  OperatorDashboardSession,
  PassengerAppSession,
} from '../../src/notifications/session.port';
import { PersistencePort } from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { FakeClock } from '../../src/platform/fake-clock';

import { RidesPersistenceDouble } from './rides';

/**
 * Sessioni che invece di spedire su una socket **registrano** ciò che ricevono.
 *
 * È il doppio del solo pezzo che i test non possono osservare — il trasporto — e nient'altro: le
 * classi di sessione sono quelle vere, e con loro il filtro «questo evento è per te?», che è la
 * regola di dominio che il cancello di M5 deve verificare. Sostituire la sessione intera con un
 * finto avrebbe verificato il finto.
 *
 * Il `transport` che il costruttore accetta è esattamente ciò che il `gateway` fornisce in
 * produzione (`client.emit`): qui accumula in un array. Che le due cose siano intercambiabili è il
 * punto della porta.
 */

/** Una sessione passeggero e le consegne che ha ricevuto, in ordine. */
export interface RecordedPassenger {
  readonly session: PassengerAppSession;
  readonly received: NotificationDelivery[];
  /** Gli stati del veicolo annunciati, nell'ordine: `['ASSIGNED', 'ARRIVING', …]`. */
  robotaxiStates(): (NotificationPush['robotaxiState'] | null)[];
  /** Gli stati della corsa annunciati, nell'ordine. */
  rideStatuses(): (NotificationPush['rideStatus'] | null)[];
}

/** Una sessione operatore e le consegne che ha ricevuto, in ordine. */
export interface RecordedOperator {
  readonly session: OperatorDashboardSession;
  readonly received: NotificationDelivery[];
  robotaxiStates(): (NotificationPush['robotaxiState'] | null)[];
}

function statesOf(
  received: readonly NotificationDelivery[],
): (NotificationPush['robotaxiState'] | null)[] {
  return received.filter((one) => one.robotaxiState !== null).map((one) => one.robotaxiState);
}

/** Registra una sessione passeggero sul manager e restituisce ciò che le arriva. */
export function recordPassenger(
  registry: NotificationSessionPort,
  passengerId: string,
): RecordedPassenger {
  const received: NotificationDelivery[] = [];
  const session = new PassengerAppSession(passengerId, (delivery) => received.push(delivery));
  registry.registerSession(session);

  return {
    session,
    received,
    robotaxiStates: () => statesOf(received),
    rideStatuses: () =>
      received.filter((one) => one.rideStatus !== null).map((one) => one.rideStatus),
  };
}

/** Registra una sessione operatore sul manager e restituisce ciò che le arriva. */
export function recordOperator(registry: NotificationSessionPort): RecordedOperator {
  const received: NotificationDelivery[] = [];
  const session = new OperatorDashboardSession((delivery) => received.push(delivery));
  registry.registerSession(session);

  return { session, received, robotaxiStates: () => statesOf(received) };
}

/**
 * Il modulo `notifications` da solo, con l'archivio in memoria al posto del database.
 *
 * Serve ai casi in cui l'oggetto del test è **l'instradamento**: dato un evento, chi lo riceve e
 * che cosa resta scritto. Costruire quegli eventi attraverso una transizione vera richiederebbe
 * flotta, corse e database, e il test finirebbe per dimostrare che la catena funziona invece che
 * che l'observer instrada bene — cosa che l'integrazione e il cancello verificano già, dove il
 * database è vero.
 *
 * `notifications` si raggiunge solo dalle sue due porte (CLAUDE.md Regola 1): `NotificationPort`
 * per iniettare gli eventi, `NotificationSessionPort` per registrare le sessioni. Il
 * `NotificationManager` concreto non compare da nessuna parte.
 */
export interface NotificationsHarness {
  readonly notifications: NotificationPort;
  readonly sessions: NotificationSessionPort;
  readonly persistence: RidesPersistenceDouble;
  readonly clock: FakeClock;
  close(): Promise<void>;
}

export async function composeNotifications(
  now = new Date('2026-05-04T09:00:00.000Z'),
): Promise<NotificationsHarness> {
  const clock = new FakeClock(now);
  const persistence = new RidesPersistenceDouble(clock);

  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [NotificationsModule],
  })
    .overrideProvider(PersistencePort)
    .useValue(persistence)
    .overrideProvider(ClockPort)
    .useValue(clock)
    .compile();

  return {
    notifications: moduleRef.get(NotificationPort),
    sessions: moduleRef.get(NotificationSessionPort),
    persistence,
    clock,
    close: () => moduleRef.close(),
  };
}
