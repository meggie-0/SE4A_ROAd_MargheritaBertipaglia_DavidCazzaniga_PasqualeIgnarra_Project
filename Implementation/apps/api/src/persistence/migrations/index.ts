import { InitialSchema1786320000000 } from './1786320000000-initial-schema';
import { BookingClosedAt1786406400000 } from './1786406400000-booking-closed-at';
import { Ride1786492800000 } from './1786492800000-ride';
import { RebalancingAction1786579200000 } from './1786579200000-rebalancing-action';
import { RidePickupReachedAt1786665600000 } from './1786665600000-ride-pickup-reached-at';
import { OperatorAlert1786752000000 } from './1786752000000-operator-alert';

/**
 * Le migrazioni, elencate esplicitamente e in ordine.
 *
 * Non un glob: sotto ts-jest i file sono `.ts`, dopo `nest build` sono `.js`, e un glob che
 * funziona in un contesto sbaglia nell'altro — con l'effetto peggiore possibile, cioè un database
 * senza schema e un errore che parla d'altro.
 */
export const ALL_MIGRATIONS = [
  InitialSchema1786320000000,
  BookingClosedAt1786406400000,
  Ride1786492800000,
  RebalancingAction1786579200000,
  RidePickupReachedAt1786665600000,
  OperatorAlert1786752000000,
];
