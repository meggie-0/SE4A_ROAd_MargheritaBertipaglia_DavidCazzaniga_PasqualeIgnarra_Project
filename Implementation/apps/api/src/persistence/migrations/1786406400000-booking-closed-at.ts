import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `booking.closed_at`: l'istante in cui l'attivatore ha **finito** con una prenotazione (M4).
 *
 * Serve a distinguere due cose che `activated_at` da solo confonde. L'attivatore cerca le
 * prenotazioni dovute con «anticipo scaduto e non ancora attivate», ma un'attivazione può finire in
 * tre modi (DD §2.4): il veicolo riservato prende la corsa, un altro la prende al suo posto, oppure
 * nessuno è idoneo e la richiesta viene rifiutata. Nel terzo caso `activated_at` resta nullo — ed è
 * corretto, perché nessuna assegnazione è avvenuta — ma la riga continuerebbe a ricadere nella
 * ricerca a ogni esecuzione, per sempre: un'interrogazione sprecata ogni minuto su una prenotazione
 * la cui sorte è già decisa. Lo stesso vale per una prenotazione annullata (R14).
 *
 * Con due colonne ognuna dice una cosa sola e vera: `activated_at` **se** è diventata
 * un'assegnazione, `closed_at` **quando** l'attivatore ha smesso di occuparsene. La ricerca guarda
 * la seconda.
 *
 * Le prenotazioni già attivate quando la migrazione gira si chiudono nello stesso istante in cui
 * risultano attivate: è l'unico valore che non inventa una cronologia.
 */
export class BookingClosedAt1786406400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "booking" ADD COLUMN "closed_at" timestamptz`);
    await queryRunner.query(
      `UPDATE "booking" SET "closed_at" = "activated_at" WHERE "activated_at" IS NOT NULL`,
    );
    // L'indice serve alla ricerca delle prenotazioni dovute, che filtra su entrambe le colonne.
    await queryRunner.query(`DROP INDEX IF EXISTS "booking_activation_due_idx"`);
    await queryRunner.query(
      `CREATE INDEX "booking_activation_due_idx"
         ON "booking" ("activation_due_at") WHERE ("closed_at" IS NULL)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "booking_activation_due_idx"`);
    await queryRunner.query(
      `CREATE INDEX "booking_activation_due_idx" ON "booking" ("activation_due_at")`,
    );
    await queryRunner.query(`ALTER TABLE "booking" DROP COLUMN "closed_at"`);
  }
}
