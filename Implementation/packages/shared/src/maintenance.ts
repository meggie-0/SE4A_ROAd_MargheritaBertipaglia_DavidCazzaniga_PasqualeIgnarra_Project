import { z } from 'zod';

import { MAINTENANCE_STATUSES } from './domain.js';
import { fleetVehicleSchema } from './fleet.js';

/**
 * Body inviato dall'operatore quando mette un robotaxi
 * in manutenzione.
 */
export const startMaintenanceRequestSchema = z.object({
  reason: z.string().trim().min(1).max(255),
});

export type StartMaintenanceRequest = z.infer<typeof startMaintenanceRequestSchema>;

/**
 * Rappresentazione pubblica di un intervento di manutenzione.
 *
 * Le date vengono trasmesse come stringhe ISO perché devono
 * attraversare l'API in formato JSON.
 */
export const maintenanceRecordSchema = z.object({
  id: z.uuid(),
  robotaxiId: z.string().min(1),
  reason: z.string(),
  status: z.enum(MAINTENANCE_STATUSES),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
});

export type MaintenanceRecordResponse = z.infer<typeof maintenanceRecordSchema>;

/**
 * Risposta di:
 *
 * POST /fleet/:robotaxiId/maintenance
 *
 * Quando la manutenzione inizia, il record esiste sempre.
 */
export const maintenanceStartedResponseSchema = z.object({
  robotaxi: fleetVehicleSchema,
  record: maintenanceRecordSchema,
});

export type MaintenanceStartedResponse = z.infer<typeof maintenanceStartedResponseSchema>;

/**
 * Risposta di:
 *
 * POST /fleet/:robotaxiId/maintenance/complete
 *
 * Il record può essere null se il robotaxi era stato inserito
 * in manutenzione dal seed senza creare uno storico.
 */
export const maintenanceCompletedResponseSchema = z.object({
  robotaxi: fleetVehicleSchema,
  record: maintenanceRecordSchema.nullable(),
});

export type MaintenanceCompletedResponse = z.infer<typeof maintenanceCompletedResponseSchema>;
