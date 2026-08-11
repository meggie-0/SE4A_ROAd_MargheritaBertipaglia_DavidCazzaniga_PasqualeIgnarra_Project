import { Injectable } from '@nestjs/common';
import {
  In,
  IsNull,
  LessThan,
  LessThanOrEqual,
  MoreThan,
  MoreThanOrEqual,
  type EntityManager,
  type EntityTarget,
  type FindOptionsOrder,
  type FindOptionsWhere,
  type ObjectLiteral,
} from 'typeorm';

import { ClockPort } from '../platform/clock.port';

import { Database } from './database';
import { ENTITY_BY_KIND } from './entities';
import {
  PersistencePort,
  RecordNotFoundError,
  ReservationConflictError,
  StaleRecordError,
  type EntityKind,
  type FindCriteria,
  type NewRecord,
  type PersistedRecord,
  type RecordFilter,
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
    expected?: RecordFilter<K>,
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
      try {
        // La condizione entra nella `WHERE` della stessa `UPDATE`: è il database a valutarla
        // nell'istante della scrittura, quindi fra il controllo e la scrittura non c'è nessuna
        // finestra in cui un altro scrittore possa infilarsi.
        const result = await repository.update({ id, ...buildWhere(expected) }, changes);
        if (result.affected === 0) {
          // Zero righe toccate significa due cose diverse — la riga non c'è, oppure c'è ma è
          // cambiata — e il chiamante ne ha una sola da gestire in modo utile. Distinguerle costa
          // una lettura, ma solo qui, cioè sul cammino raro.
          const current = await repository.findOneBy({ id });
          if (current !== null && expected !== undefined) throw new StaleRecordError(kind, id);
          throw new RecordNotFoundError(kind, id);
        }
      } catch (error) {
        // Allargare una riserva fino a sovrapporsi a un'altra è il caso della corsa che sfora
        // (DD §2.4): il vincolo la rifiuta, e qui l'errore del driver diventa un errore del
        // dominio, che il chiamante può distinguere da un guasto.
        if (isExclusionViolation(error)) throw new ReservationConflictError(id);
        throw error;
      }
    }

    const row = await repository.findOneBy({ id });
    if (row === null) throw new RecordNotFoundError(kind, id);
    return row as PersistedRecord<K>;
  }

  async find<K extends EntityKind>(
    kind: K,
    criteria: FindCriteria<K> = {},
  ): Promise<PersistedRecord<K>[]> {
    const source = await this.database.connection();
    const repository = source.getRepository(entityFor(kind));

    const order: FindOptionsOrder<ObjectLiteral> = {};
    for (const sort of criteria.orderBy ?? [{ field: 'id' }]) {
      order[sort.field] = sort.direction === 'desc' ? 'DESC' : 'ASC';
    }

    const rows = await repository.find({
      where: buildWhere(criteria.where),
      order,
      ...(criteria.limit === undefined ? {} : { take: criteria.limit }),
    });

    return rows as PersistedRecord<K>[];
  }

  async filterAvailable(robotaxiIds: readonly string[], window: TimeWindow): Promise<string[]> {
    if (robotaxiIds.length === 0) return [];

    const source = await this.database.connection();
    // `NOT EXISTS` invece di una `LEFT JOIN` con filtro: dice esattamente ciò che la porta
    // promette — nessuna riserva sovrapposta — e resta vero anche con più riserve per veicolo.
    // L'intervallo è semiaperto, quindi due finestre che si toccano non si escludono a vicenda.
    // Le riserve rilasciate non contano: è la stessa condizione del vincolo di esclusione, che è
    // parziale su `released_at IS NULL`, e le due devono restare d'accordo.
    const rows: ReadonlyArray<{ id: string }> = await source.query(
      `SELECT candidate AS id
         FROM unnest($1::varchar[]) AS candidate
        WHERE NOT EXISTS (
              SELECT 1
                FROM "robotaxi_reservation" reservation
               WHERE reservation."robotaxi_id" = candidate
                 AND reservation."released_at" IS NULL
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
          releasedAt: null,
        });

        // La prenotazione anticipata nasce nella stessa transazione della riserva: o esistono
        // entrambe le righe o nessuna (MILESTONES.md §M4). Richiesta e riserva le prende da qui,
        // non dal chiamante, così non possono divergere.
        const booking =
          input.booking === undefined
            ? null
            : await this.insert(manager, 'booking', {
                ...input.booking,
                rideRequestId: input.rideRequestId,
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

/**
 * Traduce i criteri della porta nelle condizioni di TypeORM.
 *
 * L'insieme dei confronti è chiuso (vedi `FieldCriterion`): ogni ramo qui sotto corrisponde a uno
 * di essi, e un valore nudo significa uguaglianza. `null` diventa `IS NULL`, perché in SQL
 * `= NULL` non è mai vero — una svista che farebbe restituire zero righe invece di quelle giuste.
 */
function buildWhere<K extends EntityKind>(
  filter: RecordFilter<K> | undefined,
): FindOptionsWhere<ObjectLiteral> | undefined {
  if (filter === undefined) return undefined;

  const where: FindOptionsWhere<ObjectLiteral> = {};

  for (const [field, criterion] of Object.entries(filter)) {
    if (criterion === undefined) continue;
    if (criterion === null) {
      where[field] = IsNull();
      continue;
    }

    if (typeof criterion === 'object' && !(criterion instanceof Date)) {
      const comparison = criterion as {
        atMost?: unknown;
        atLeast?: unknown;
        lessThan?: unknown;
        greaterThan?: unknown;
        oneOf?: readonly unknown[];
      };

      if (comparison.atMost !== undefined) where[field] = LessThanOrEqual(comparison.atMost);
      else if (comparison.atLeast !== undefined) where[field] = MoreThanOrEqual(comparison.atLeast);
      else if (comparison.lessThan !== undefined) where[field] = LessThan(comparison.lessThan);
      else if (comparison.greaterThan !== undefined)
        where[field] = MoreThan(comparison.greaterThan);
      else if (comparison.oneOf !== undefined) where[field] = In([...comparison.oneOf]);
      else where[field] = criterion;
      continue;
    }

    where[field] = criterion;
  }

  return where;
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
