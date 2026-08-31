import { CONTROL_MODES, OPERATOR_ALERT_KINDS, STRATEGY_NAMES, TRAFFIC_LEVELS } from '@road/shared';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `operator_alert` — lo storico degli avvisi sul governo del sistema (decisione D77).
 *
 * Mancava per una ragione diversa da quella di `ride` e `rebalancing_action`, che semplicemente non
 * servivano ancora: questa tabella manca perché il posto dove quei dati sarebbero dovuti andare —
 * `notification` — **non poteva accoglierli**. Due suoi vincoli lo impediscono, e insieme:
 * `recipient_id uuid NOT NULL REFERENCES "user"` e
 * `type varchar(40) NOT NULL CHECK (type IN (…))`. I quattro eventi di governo non hanno né l'uno
 * né l'altro, e `NotificationManager.record()` esce infatti su entrambe le condizioni. Il risultato
 * è che dal M6 a oggi gli alert dell'operatore **non sono mai stati persistiti**, e il pannello che
 * li mostra riparte vuoto a ogni ricaricamento.
 *
 * **Nessuna chiave esterna, ed è la differenza con `rebalancing_action`.** Quella tabella è un
 * giornale *operativo*: le sue righe descrivono azioni in corso, e legarle al veicolo e alla zona è
 * giusto perché l'azione non ha senso senza di loro. Questa è uno *storico*: dice com'era il mondo
 * allora. `zone_id` e `robotaxi_id` sono copie, non riferimenti — con una `CASCADE` cancellare un
 * veicolo riscriverebbe il passato, con una `SET NULL` lo impoverirebbe, e con una `RESTRICT` il
 * passato impedirebbe al presente di cambiare.
 *
 * L'indice è su `occurred_at` e non su un destinatario, perché non c'è un destinatario: l'unica
 * interrogazione è «gli ultimi N, dal più recente».
 */
const values = (allowed: readonly string[]): string =>
  allowed.map((value) => `'${value}'`).join(', ');

export class OperatorAlert1786752000000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "operator_alert" (
        "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "kind"          varchar(40) NOT NULL CHECK ("kind" IN (${values(OPERATOR_ALERT_KINDS)})),
        "message"       varchar(500) NOT NULL,
        "occurred_at"   timestamptz NOT NULL,
        "strategy"      varchar(40) CHECK ("strategy" IN (${values(STRATEGY_NAMES)})),
        "mode"          varchar(20) CHECK ("mode" IN (${values(CONTROL_MODES)})),
        "traffic_level" varchar(20) CHECK ("traffic_level" IN (${values(TRAFFIC_LEVELS)})),
        "zone_id"       varchar(64),
        "robotaxi_id"   varchar(64)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "operator_alert_occurred_idx" ON "operator_alert" ("occurred_at" DESC)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "operator_alert"`);
  }
}
