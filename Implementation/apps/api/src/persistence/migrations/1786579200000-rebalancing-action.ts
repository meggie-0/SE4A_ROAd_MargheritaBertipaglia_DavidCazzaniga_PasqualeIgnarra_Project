import { REBALANCING_STATUSES } from '@road/shared';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `rebalancing_action` — il giornale del riposizionamento proattivo (M6, RASD §2.2.3, R11, G9).
 *
 * Mancava per la stessa ragione per cui mancava `ride`: MILESTONES.md §M1 elenca undici tabelle e
 * questa non è fra quelle, perché nessun componente di M1–M5 aveva niente da scriverci. È
 * `RebalancingManager` a chiederla, e non per completezza documentale: `FleetMonitor.requestRebalancing()`
 * porta il veicolo a `REBALANCING` ma non riceve la zona di destinazione — il DD la fa viaggiare su
 * `ExternalServicesPort.commandRoute()`, che nasce in M7 — quindi senza questa riga *dove* un
 * veicolo stia andando non sarebbe scritto in nessun posto.
 *
 * **Le chiavi esterne sono `ON DELETE CASCADE` verso il veicolo e `RESTRICT` verso la zona**, e
 * l'asimmetria è voluta: un veicolo ritirato dalla flotta si porta via il proprio storico di
 * movimenti, mentre le zone sono la partizione fissa della città (decisione D10) e cancellarne una
 * mentre un'azione la punta significherebbe che quella partizione è cambiata sotto i piedi del
 * sistema — meglio che il database si rifiuti.
 */
const values = (allowed: readonly string[]): string =>
  allowed.map((value) => `'${value}'`).join(', ');

export class RebalancingAction1786579200000 implements MigrationInterface {
  name = 'RebalancingAction1786579200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "rebalancing_action" (
        "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "robotaxi_id"     varchar(40) NOT NULL REFERENCES "robotaxi" ("id") ON DELETE CASCADE,
        "target_zone_id"  varchar(60) NOT NULL REFERENCES "zone" ("id") ON DELETE RESTRICT,
        "status"          varchar(20) NOT NULL CHECK ("status" IN (${values(REBALANCING_STATUSES)})),
        "created_at"      timestamptz NOT NULL
      )
    `);

    // La ricerca che la dashboard fa: i movimenti di un veicolo, dal più recente.
    await queryRunner.query(
      `CREATE INDEX "rebalancing_action_robotaxi_idx" ON "rebalancing_action" ("robotaxi_id", "created_at" DESC)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "rebalancing_action"`);
  }
}
