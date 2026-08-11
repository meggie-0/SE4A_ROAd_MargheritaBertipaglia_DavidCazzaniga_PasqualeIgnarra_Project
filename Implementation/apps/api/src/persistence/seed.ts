import { DEFAULT_STRATEGY } from '@road/shared';

import { runCommand } from './cli-context';
import { Database } from './database';
import { SYSTEM_MODE_ID } from './entities';
import { PersistencePort } from './persistence.port';
import { DEMAND_EVENT_RECORDS, ZONE_RECORDS, demandSampleRecords, fleetRecords } from './seed-data';

/**
 * `pnpm db:seed`.
 *
 * Riporta il database ai dati di partenza di MILESTONES.md §M1: 16 zone, 20 robotaxi, una
 * settimana di domanda di base, tre eventi. È **ripetibile** — svuota prima di scrivere — perché
 * un comando che fallisce alla seconda esecuzione è un comando che nessuno userà davvero.
 *
 * Le righe passano tutte da `PersistencePort`: se il seed avesse una via privata al database, il
 * dato seminato potrebbe non essere quello che il resto del sistema sa scrivere.
 */

/** L'ordine conta: le figlie prima delle madri, o le chiavi esterne si oppongono. */
const TABLES_TO_CLEAR = [
  'notification',
  'booking',
  'robotaxi_reservation',
  'ride_request',
  'maintenance_record',
  'demand_event',
  'demand_sample',
  'robotaxi',
  'user',
  'zone',
];

runCommand(async (context) => {
  const persistence = context.get(PersistencePort);
  const source = await context.get(Database).connection();

  const quoted = TABLES_TO_CLEAR.map((table) => `"${table}"`).join(', ');
  await source.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

  for (const zone of ZONE_RECORDS) await persistence.create('zone', zone);
  for (const robotaxi of fleetRecords()) await persistence.create('robotaxi', robotaxi);

  const samples = demandSampleRecords();
  for (const sample of samples) await persistence.create('demand_sample', sample);
  for (const event of DEMAND_EVENT_RECORDS) await persistence.create('demand_event', event);

  // `system_mode` non si svuota: la riga singleton nasce con lo schema. Il seed la riporta al
  // default del RASD §2.4 — NearestAvailable, modo Auto — senza cancellarla.
  await persistence.update('system_mode', SYSTEM_MODE_ID, {
    activeStrategy: DEFAULT_STRATEGY,
    mode: 'AUTO',
    lastTrafficLevel: null,
  });

  console.log(`Zone: ${ZONE_RECORDS.length}`);
  console.log(`Robotaxi: ${fleetRecords().length}`);
  console.log(`Campioni di domanda: ${samples.length}`);
  console.log(`Eventi di domanda: ${DEMAND_EVENT_RECORDS.length}`);
  console.log(`Strategia attiva riportata a ${DEFAULT_STRATEGY} in modo AUTO.`);
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
