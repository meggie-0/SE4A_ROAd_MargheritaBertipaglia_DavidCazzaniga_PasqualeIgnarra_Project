import {
  CONTROL_MODES,
  DEFAULT_STRATEGY,
  MAINTENANCE_STATUSES,
  NOTIFICATION_TYPES,
  RIDE_REQUEST_KINDS,
  RIDE_REQUEST_STATUSES,
  ROBOTAXI_STATES,
  STRATEGY_NAMES,
  TRAFFIC_LEVELS,
  USER_ROLES,
} from '@road/shared';
import type { MigrationInterface, QueryRunner } from 'typeorm';

import { SYSTEM_MODE_ID } from '../entities/system-mode.entity';

/**
 * Lo schema iniziale di ROAd (MILESTONES.md §M1).
 *
 * Due scelte meritano di essere lette prima del resto:
 *
 * 1. **Il vincolo di esclusione** su `robotaxi_reservation` è il cuore della milestone. Impedisce
 *    che due riserve dello stesso veicolo si sovrappongano *qualunque sia l'interleaving degli
 *    scrittori* (NFR4, G10, vincolo C1 del RASD), perché a rifiutarle è il database e non il codice
 *    applicativo: nessuna finestra di tempo fra il controllo e la scrittura in cui un secondo
 *    scrittore possa infilarsi.
 *
 * 2. **Gli intervalli sono limitati.** Il `CHECK` su `lower()`/`upper()` traduce in schema la
 *    decisione D8: un estremo aperto renderebbe impossibile qualunque prenotazione futura sullo
 *    stesso veicolo, e la milestone lo vieta esplicitamente.
 *
 * I domini enumerati sono `CHECK ... IN (...)` costruiti dalle costanti di `@road/shared` invece
 * che da elenchi ricopiati a mano: documento, codice e database restano allineati per costruzione,
 * e aggiungere uno stato senza una migrazione diventa impossibile invece che silenzioso.
 */

/** `'A', 'B', 'C'` — l'elenco di valori ammessi in un `CHECK ... IN (...)`. */
const values = (allowed: readonly string[]): string =>
  allowed.map((value) => `'${value}'`).join(', ');

export class InitialSchema1786320000000 implements MigrationInterface {
  name = 'InitialSchema1786320000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // Serve al vincolo di esclusione: senza btree_gist un indice GiST non sa confrontare
    // `robotaxi_id` per uguaglianza accanto a un intervallo per sovrapposizione.
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS btree_gist`);

    await queryRunner.query(`
      CREATE TABLE "zone" (
        "id"   varchar(60)  PRIMARY KEY,
        "name" varchar(120) NOT NULL,
        "lat"  double precision NOT NULL CHECK ("lat" BETWEEN -90 AND 90),
        "lon"  double precision NOT NULL CHECK ("lon" BETWEEN -180 AND 180)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "email"         varchar(320) NOT NULL UNIQUE,
        "password_hash" varchar(255) NOT NULL,
        "name"          varchar(120) NOT NULL,
        "surname"       varchar(120) NOT NULL,
        "phone_number"  varchar(40),
        "role"          varchar(20)  NOT NULL CHECK ("role" IN (${values(USER_ROLES)})),
        "created_at"    timestamptz  NOT NULL
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "robotaxi" (
        "id"         varchar(40) PRIMARY KEY,
        "state"      varchar(20) NOT NULL CHECK ("state" IN (${values(ROBOTAXI_STATES)})),
        "lat"        double precision NOT NULL CHECK ("lat" BETWEEN -90 AND 90),
        "lon"        double precision NOT NULL CHECK ("lon" BETWEEN -180 AND 180),
        "zone_id"    varchar(60) REFERENCES "zone" ("id") ON DELETE SET NULL,
        "updated_at" timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "robotaxi_state_idx" ON "robotaxi" ("state")`);

    await queryRunner.query(`
      CREATE TABLE "ride_request" (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "passenger_id"          uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "kind"                  varchar(20) NOT NULL CHECK ("kind" IN (${values(RIDE_REQUEST_KINDS)})),
        "status"                varchar(20) NOT NULL CHECK ("status" IN (${values(RIDE_REQUEST_STATUSES)})),
        "pickup_lat"            double precision NOT NULL,
        "pickup_lon"            double precision NOT NULL,
        "pickup_address"        varchar(255),
        "destination_lat"       double precision NOT NULL,
        "destination_lon"       double precision NOT NULL,
        "destination_address"   varchar(255),
        "assigned_robotaxi_id"  varchar(40) REFERENCES "robotaxi" ("id") ON DELETE SET NULL,
        "created_at"            timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "ride_request_status_idx" ON "ride_request" ("status")`);

    await queryRunner.query(`
      CREATE TABLE "robotaxi_reservation" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "robotaxi_id"     varchar(40) NOT NULL REFERENCES "robotaxi" ("id") ON DELETE CASCADE,
        "ride_request_id" uuid NOT NULL REFERENCES "ride_request" ("id") ON DELETE CASCADE,
        "period"          tstzrange NOT NULL,
        "created_at"      timestamptz NOT NULL,
        -- Decisione D8: mai un intervallo illimitato, e mai uno vuoto (che non escluderebbe nulla).
        CONSTRAINT "reservation_period_is_bounded"
          CHECK (lower("period") IS NOT NULL AND upper("period") IS NOT NULL),
        CONSTRAINT "reservation_period_is_not_empty" CHECK (NOT isempty("period"))
      )
    `);

    // L'invariante centrale della milestone (NFR4, G10, C1).
    await queryRunner.query(`
      ALTER TABLE "robotaxi_reservation"
        ADD CONSTRAINT "no_overlapping_reservations"
        EXCLUDE USING gist ("robotaxi_id" WITH =, "period" WITH &&)
    `);

    await queryRunner.query(`
      CREATE TABLE "booking" (
        "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ride_request_id"   uuid NOT NULL UNIQUE REFERENCES "ride_request" ("id") ON DELETE CASCADE,
        "robotaxi_id"       varchar(40) REFERENCES "robotaxi" ("id") ON DELETE SET NULL,
        "reservation_id"    uuid REFERENCES "robotaxi_reservation" ("id") ON DELETE SET NULL,
        "scheduled_pickup"  timestamptz NOT NULL,
        "activation_due_at" timestamptz NOT NULL,
        "activated_at"      timestamptz,
        "created_at"        timestamptz NOT NULL,
        CONSTRAINT "booking_activation_precedes_pickup"
          CHECK ("activation_due_at" <= "scheduled_pickup")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "booking_activation_due_idx" ON "booking" ("activation_due_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "demand_sample" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "zone_id"     varchar(60) NOT NULL REFERENCES "zone" ("id") ON DELETE CASCADE,
        "day_of_week" smallint NOT NULL CHECK ("day_of_week" BETWEEN 0 AND 6),
        "hour_of_day" smallint NOT NULL CHECK ("hour_of_day" BETWEEN 0 AND 23),
        "base_demand" double precision NOT NULL CHECK ("base_demand" >= 0)
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "demand_sample_slot_uq"
        ON "demand_sample" ("zone_id", "day_of_week", "hour_of_day")
    `);

    await queryRunner.query(`
      CREATE TABLE "demand_event" (
        "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "zone_id"    varchar(60) NOT NULL REFERENCES "zone" ("id") ON DELETE CASCADE,
        "name"       varchar(160) NOT NULL,
        "starts_at"  timestamptz NOT NULL,
        "ends_at"    timestamptz NOT NULL,
        "multiplier" double precision NOT NULL CHECK ("multiplier" > 0),
        CONSTRAINT "demand_event_window_is_ordered" CHECK ("starts_at" < "ends_at")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "demand_event_window_idx"
        ON "demand_event" ("zone_id", "starts_at", "ends_at")
    `);

    await queryRunner.query(`
      CREATE TABLE "maintenance_record" (
        "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "robotaxi_id" varchar(40) NOT NULL REFERENCES "robotaxi" ("id") ON DELETE CASCADE,
        "reason"      varchar(255) NOT NULL,
        "status"      varchar(20) NOT NULL CHECK ("status" IN (${values(MAINTENANCE_STATUSES)})),
        "started_at"  timestamptz NOT NULL,
        "ended_at"    timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "maintenance_record_robotaxi_idx"
        ON "maintenance_record" ("robotaxi_id", "status")
    `);

    await queryRunner.query(`
      CREATE TABLE "system_mode" (
        "id"                 varchar(20) PRIMARY KEY CHECK ("id" = '${SYSTEM_MODE_ID}'),
        "active_strategy"    varchar(40) NOT NULL CHECK ("active_strategy" IN (${values(STRATEGY_NAMES)})),
        "mode"               varchar(20) NOT NULL CHECK ("mode" IN (${values(CONTROL_MODES)})),
        "last_traffic_level" varchar(20) CHECK ("last_traffic_level" IN (${values(TRAFFIC_LEVELS)})),
        "updated_at"         timestamptz NOT NULL
      )
    `);

    // La riga singleton nasce con lo schema, non con il seed: il sistema deve poter rispondere
    // "qual è la strategia attiva?" anche su un database mai seminato, e il default è
    // NearestAvailable in modo Auto (RASD §2.4).
    await queryRunner.query(`
      INSERT INTO "system_mode" ("id", "active_strategy", "mode", "last_traffic_level", "updated_at")
      VALUES ('${SYSTEM_MODE_ID}', '${DEFAULT_STRATEGY}', 'AUTO', NULL, now())
    `);

    await queryRunner.query(`
      CREATE TABLE "notification" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "recipient_id"    uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "ride_request_id" uuid REFERENCES "ride_request" ("id") ON DELETE SET NULL,
        "type"            varchar(40) NOT NULL CHECK ("type" IN (${values(NOTIFICATION_TYPES)})),
        "message"         varchar(500) NOT NULL,
        "created_at"      timestamptz NOT NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "notification_recipient_idx"
        ON "notification" ("recipient_id", "created_at")
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'notification',
      'system_mode',
      'maintenance_record',
      'demand_event',
      'demand_sample',
      'booking',
      'robotaxi_reservation',
      'ride_request',
      'robotaxi',
      'user',
      'zone',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
  }
}
