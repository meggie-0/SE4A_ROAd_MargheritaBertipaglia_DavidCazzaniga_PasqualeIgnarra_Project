import type { EntityKind } from '../persistence.port';

import { BookingEntity } from './booking.entity';
import { DemandEventEntity } from './demand-event.entity';
import { DemandSampleEntity } from './demand-sample.entity';
import { MaintenanceRecordEntity } from './maintenance-record.entity';
import { NotificationEntity } from './notification.entity';
import { RebalancingActionEntity } from './rebalancing-action.entity';
import { ReservationEntity } from './reservation.entity';
import { RideEntity } from './ride.entity';
import { RideRequestEntity } from './ride-request.entity';
import { RobotaxiEntity } from './robotaxi.entity';
import { SystemModeEntity } from './system-mode.entity';
import { UserEntity } from './user.entity';
import { ZoneEntity } from './zone.entity';

export { BookingEntity } from './booking.entity';
export { DemandEventEntity } from './demand-event.entity';
export { DemandSampleEntity } from './demand-sample.entity';
export { MaintenanceRecordEntity } from './maintenance-record.entity';
export { NotificationEntity } from './notification.entity';
export { RebalancingActionEntity } from './rebalancing-action.entity';
export { ReservationEntity } from './reservation.entity';
export { RideEntity } from './ride.entity';
export { RideRequestEntity } from './ride-request.entity';
export { RobotaxiEntity } from './robotaxi.entity';
export { SystemModeEntity, SYSTEM_MODE_ID } from './system-mode.entity';
export { UserEntity } from './user.entity';
export { ZoneEntity } from './zone.entity';

/**
 * Dal nome della tabella alla classe che la mappa.
 *
 * `PersistencePort.create`/`update` sono generiche su `EntityKind` (il nome della tabella) e qui
 * trovano l'entità corrispondente. `satisfies Record<EntityKind, …>` non è decorativo: se domani
 * si aggiunge una chiave al registro dei record senza aggiungere l'entità, il compilatore lo dice
 * subito invece di lasciare un errore a runtime alla prima `create`.
 */
export const ENTITY_BY_KIND = {
  user: UserEntity,
  zone: ZoneEntity,
  robotaxi: RobotaxiEntity,
  ride_request: RideRequestEntity,
  ride: RideEntity,
  booking: BookingEntity,
  robotaxi_reservation: ReservationEntity,
  demand_sample: DemandSampleEntity,
  demand_event: DemandEventEntity,
  maintenance_record: MaintenanceRecordEntity,
  rebalancing_action: RebalancingActionEntity,
  system_mode: SystemModeEntity,
  notification: NotificationEntity,
} as const satisfies Record<EntityKind, new () => object>;

/** Tutte le entità, nella forma che il `DataSource` si aspetta. */
export const ALL_ENTITIES = Object.values(ENTITY_BY_KIND);
