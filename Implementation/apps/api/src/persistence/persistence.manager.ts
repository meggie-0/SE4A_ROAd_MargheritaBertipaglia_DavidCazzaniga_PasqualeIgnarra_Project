import { Injectable } from '@nestjs/common';
import type { EntityManager, EntityTarget, ObjectLiteral } from 'typeorm';

import { ClockPort } from '../platform/clock.port';

import { Database } from './database';
import { ENTITY_BY_KIND } from './entities';
import {
  PersistencePort,
  RecordNotFoundError,
  type EntityKind,
  type NewRecord,
  type PersistedRecord,
  type RecordPatch,
  type ReservationInput,
  type ReservationOutcome,
  type TimeWindow,
} from './persistence.port';

/** SQLSTATE `exclusion_violation`: il vincolo `no_overlapping_reservations` ha rifiutato la riga. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * L'implementazione TypeORM del `PersistenceManager` (DD §2.2).
 *
 * È l'unico componente che parla con il database. Tre cose meritano attenzione:
 *
 * - **Le date vengono da `ClockPort`**, non da `new Date()` né dal `now()` di PostgreSQL: senza
 *   questo, i test su prenotazioni anticipate e rebalancing non potrebbero fissare il tempo
 *   (CLAUDE.md Regola 3).
 * - **Gli identificatori generati li produce il database** con `gen_random_uuid()`. Generarli qui
 *   avrebbe richiesto una sorgente di casualità nel dominio, e con più repliche del tier
 *   applicativo (NFR3) una sorgente *con seme* — l'unica ammessa — produrrebbe gli stessi
 *   identificatori su istanze diverse.
 * - **La sovrapposizione delle riserve non è controllata qui.** La rifiuta il vincolo di
 *   esclusione del database, che è ciò che rende l'invariante vero *qualunque* sia l'interleaving
 *   degli scrittori (NFR4). Un controllo applicativo lascerebbe scoperta la finestra fra la
 *   lettura e la scrittura.
 */
@Injectable()
export class PersistenceManager extends PersistencePort {
  constructor(
    private readonly database: Database,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async create<K extends EntityKind>(kind: K, data: NewRecord<K>): Promise<PersistedRecord<K>> {
    const source = await this.database.connection();
    return this.insert(source.manager, kind, data);
  }

  async update<K extends EntityKind>(
    kind: K,
    id: string,
    patch: RecordPatch<K>,
  ): Promise<PersistedRecord<K>> {
    const source = await this.database.connection();
    const target = entityFor(kind);
    const repository = source.getRepository(target);

    const changes: ObjectLiteral = { ...patch };
    // Una riga che cambia porta la data dell'ultima modifica, a meno che il chiamante non ne
    // imponga una propria (il seed lo fa, per restare riproducibile).
    if (hasColumn(source.manager, target, 'updatedAt') && changes.updatedAt === undefined) {
      changes.updatedAt = this.clock.now();
    }

    if (Object.keys(changes).length > 0) {
      const result = await repository.update({ id }, changes);
      if (result.affected === 0) throw new RecordNotFoundError(kind, id);
    }

    const row = await repository.findOneBy({ id });
    if (row === null) throw new RecordNotFoundError(kind, id);
    return row as PersistedRecord<K>;
  }

  async filterAvailable(robotaxiIds: readonly string[], window: TimeWindow): Promise<string[]> {
    if (robotaxiIds.length === 0) return [];

    const source = await this.database.connection();
    // `NOT EXISTS` invece di una `LEFT JOIN` con filtro: dice esattamente ciò che la porta
    // promette — nessuna riserva sovrapposta — e resta vero anche con più riserve per veicolo.
    // L'intervallo è semiaperto, quindi due finestre che si toccano non si escludono a vicenda.
    const rows: ReadonlyArray<{ id: string }> = await source.query(
      `SELECT candidate AS id
         FROM unnest($1::varchar[]) AS candidate
        WHERE NOT EXISTS (
              SELECT 1
                FROM "robotaxi_reservation" reservation
               WHERE reservation."robotaxi_id" = candidate
                 AND reservation."period" && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        )
        ORDER BY candidate ASC`,
      [[...robotaxiIds], window.start.toISOString(), window.end.toISOString()],
    );

    return rows.map((row) => row.id);
  }

  async reserve(input: ReservationInput): Promise<ReservationOutcome> {
    try {
      return await this.database.transaction(async (manager) => {
        // `SKIP LOCKED` e non un'attesa: se un'altra transazione sta già decidendo su questo
        // veicolo, chi arriva secondo non si mette in coda ma rinuncia subito, così il chiamante
        // può ri-allocare su un altro candidato invece di restare bloccato (NFR1).
        const locked: ReadonlyArray<{ id: string }> = await manager.query(
          `SELECT "id" FROM "robotaxi" WHERE "id" = $1 FOR UPDATE SKIP LOCKED`,
          [input.robotaxiId],
        );

        if (locked.length === 0) {
          const known: ReadonlyArray<{ id: string }> = await manager.query(
            `SELECT "id" FROM "robotaxi" WHERE "id" = $1`,
            [input.robotaxiId],
          );
          return {
            reserved: false,
            reason: known.length === 0 ? 'UNKNOWN_ROBOTAXI' : 'ROBOTAXI_BUSY',
          };
        }

        const reservation = await this.insert(manager, 'robotaxi_reservation', {
          robotaxiId: input.robotaxiId,
          rideRequestId: input.rideRequestId,
          period: input.window,
        });

        // La prenotazione anticipata nasce nella stessa transazione della riserva: o esistono
        // entrambe le righe o nessuna (MILESTONES.md §M4).
        const booking =
          input.booking === undefined
            ? null
            : await this.insert(manager, 'booking', {
                ...input.booking,
                reservationId: reservation.id,
              });

        return { reserved: true, reservation, booking };
      });
    } catch (error) {
      // Il rifiuto arriva dal database, non da un controllo qui sopra: è ciò che lo rende valido
      // per ogni scrittore, comprese repliche che questo processo non conosce.
      if (isExclusionViolation(error)) {
        return { reserved: false, reason: 'OVERLAPPING_RESERVATION' };
      }
      throw error;
    }
  }

  /** Scrive una riga e la rilegge, così il chiamante ottiene anche i campi generati dal database. */
  private async insert<K extends EntityKind>(
    manager: EntityManager,
    kind: K,
    data: NewRecord<K>,
  ): Promise<PersistedRecord<K>> {
    const target = entityFor(kind);
    const values: ObjectLiteral = { ...data };

    const now = this.clock.now();
    for (const column of ['createdAt', 'updatedAt'] as const) {
      if (hasColumn(manager, target, column) && values[column] === undefined) {
        values[column] = now;
      }
    }
    // Una chiave assente dev'essere assente dalla `INSERT`, non presente e nulla: è il default
    // `gen_random_uuid()` della colonna a doverla riempire.
    if (values.id === undefined) delete values.id;

    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(target)
      .values(values)
      .returning('id')
      .execute();

    const id = (inserted.raw as ReadonlyArray<{ id: string }>)[0]?.id;
    if (id === undefined) throw new Error(`L'inserimento in "${kind}" non ha restituito un id.`);

    const row = await manager.getRepository(target).findOneBy({ id });
    if (row === null) throw new RecordNotFoundError(kind, id);
    return row as PersistedRecord<K>;
  }
}

/** La classe entità che mappa una tabella. Il cast tiene l'ORM confinato dietro la porta. */
function entityFor(kind: EntityKind): EntityTarget<ObjectLiteral> {
  return ENTITY_BY_KIND[kind] as EntityTarget<ObjectLiteral>;
}

/** Se la tabella ha quella colonna. Lo chiede ai metadati invece di tenerne un elenco a mano. */
function hasColumn(
  manager: EntityManager,
  target: EntityTarget<ObjectLiteral>,
  property: string,
): boolean {
  return manager.connection
    .getMetadata(target)
    .columns.some((column) => column.propertyName === property);
}

/**
 * Se l'errore è la violazione del vincolo di esclusione.
 *
 * TypeORM copia il codice del driver sull'errore che solleva, ma il controllo guarda anche
 * `driverError`: dipendere da un solo punto di una libreria di terze parti significherebbe che un
 * suo aggiornamento trasforma un conflitto previsto in un errore 500.
 */
function isExclusionViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; driverError?: { code?: unknown } };
  return (
    candidate.code === EXCLUSION_VIOLATION || candidate.driverError?.code === EXCLUSION_VIOLATION
  );
}
