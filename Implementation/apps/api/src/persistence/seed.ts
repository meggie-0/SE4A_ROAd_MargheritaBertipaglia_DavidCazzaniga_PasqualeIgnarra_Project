import { ConfigService } from '@nestjs/config';
import { DEFAULT_STRATEGY, type UserRole } from '@road/shared';

import { AuthPort } from '../auth/auth.port';

import { runCommand } from './cli-context';
import { Database } from './database';
import { SYSTEM_MODE_ID } from './entities';
import { PersistencePort } from './persistence.port';
import { DEMAND_EVENT_RECORDS, ZONE_RECORDS, demandSampleRecords, fleetRecords } from './seed-data';

/**
 * `pnpm db:seed`.
 *
 * Riporta il database ai dati di partenza di MILESTONES.md §M1: 16 zone, 64 robotaxi, una
 * settimana di domanda di base, tre eventi. È **ripetibile** — svuota prima di scrivere — perché
 * un comando che fallisce alla seconda esecuzione è un comando che nessuno userà davvero.
 *
 * Le righe passano tutte da `PersistencePort`: se il seed avesse una via privata al database, il
 * dato seminato potrebbe non essere quello che il resto del sistema sa scrivere.
 */

/**
 * L'ordine conta: le figlie prima delle madri, o le chiavi esterne si oppongono.
 *
 * `ride` e `rebalancing_action` sono nell'elenco anche se il `CASCADE` le porterebbe via comunque
 * passando dalle madri: contare su quello significa che l'elenco non dice più quali tabelle il
 * comando svuota, e la prima tabella nuova senza chiave esterna verso queste resterebbe piena senza
 * che nulla lo segnali.
 */
const TABLES_TO_CLEAR = [
  'notification',
  'rebalancing_action',
  'ride',
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

/**
 * Gli account di partenza (M1b).
 *
 * Il RASD §1.4 elenca «Passenger registration» ma non quella di un operatore: senza un account
 * seminato, nessuno potrebbe mai entrare come `OPERATOR` e metà di R1 resterebbe indimostrabile.
 * Il passeggero c'è per simmetria, così una dimostrazione parte da un database seminato senza
 * doversi prima iscrivere.
 *
 * Le credenziali vengono dall'ambiente e non dal codice (CLAUDE.md, «Cose da non fare»); i valori
 * di `.env.example` sono di sviluppo e vanno cambiati ovunque non sia una macchina locale.
 */
const SEED_ACCOUNTS: ReadonlyArray<{
  readonly role: UserRole;
  readonly emailVariable: string;
  readonly passwordVariable: string;
  readonly name: string;
  readonly surname: string;
  readonly phoneNumber: string | null;
}> = [
  {
    role: 'OPERATOR',
    emailVariable: 'SEED_OPERATOR_EMAIL',
    passwordVariable: 'SEED_OPERATOR_PASSWORD',
    name: 'Ada',
    surname: 'Operatrice',
    phoneNumber: null,
  },
  {
    role: 'PASSENGER',
    emailVariable: 'SEED_PASSENGER_EMAIL',
    passwordVariable: 'SEED_PASSENGER_PASSWORD',
    name: 'Giulia',
    surname: 'Rossi',
    phoneNumber: '+39 333 1234567',
  },
];

runCommand(async (context) => {
  const persistence = context.get(PersistencePort);
  const auth = context.get(AuthPort);
  const config = context.get(ConfigService);
  const source = await context.get(Database).connection();

  const quoted = TABLES_TO_CLEAR.map((table) => `"${table}"`).join(', ');
  await source.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);

  for (const account of SEED_ACCOUNTS) {
    // `getOrThrow` e non un default: una password di seed scritta nel codice sarebbe un segreto
    // nel codice, e una vuota creerebbe un account che chiunque può usare senza che nessuno se ne
    // accorga. Meglio un comando che si ferma dicendo quale variabile manca.
    await auth.register({
      email: config.getOrThrow<string>(account.emailVariable),
      password: config.getOrThrow<string>(account.passwordVariable),
      name: account.name,
      surname: account.surname,
      phoneNumber: account.phoneNumber,
      role: account.role,
    });
  }

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

  console.log(`Account: ${SEED_ACCOUNTS.map((account) => account.role).join(', ')}`);
  console.log(`Zone: ${ZONE_RECORDS.length}`);
  console.log(`Robotaxi: ${fleetRecords().length}`);
  console.log(`Campioni di domanda: ${samples.length}`);
  console.log(`Eventi di domanda: ${DEMAND_EVENT_RECORDS.length}`);
  console.log(`Strategia attiva riportata a ${DEFAULT_STRATEGY} in modo AUTO.`);
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
