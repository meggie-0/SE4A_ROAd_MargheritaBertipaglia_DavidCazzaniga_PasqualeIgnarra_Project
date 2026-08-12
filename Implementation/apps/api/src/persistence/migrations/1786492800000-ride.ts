import { RIDE_STATUSES } from '@road/shared';
import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ride` — il servizio di trasporto generato da una richiesta accettata (M5, RASD §2.2.3).
 *
 * La tabella mancava, e non per dimenticanza di chi ha scritto M1: lo schema iniziale copre le
 * undici tabelle che MILESTONES.md §M1 elenca, e `Ride` non è fra quelle. È M5 a chiederla, perché
 * l'Observer del DD §2.3.3 ha **due** soggetti — `Robotaxi` e `Ride` — e finora esisteva solo il
 * primo. Il DD non se n'era accorto: la §2.3.3 disegna `Ride` come `Subject` senza che nessuna
 * tabella lo sostenga.
 *
 * **Perché non basta `ride_request`.** Sono due cicli di vita distinti, e il RASD li separa
 * apposta (§2.2.1: «An accepted Ride Request can generate one Ride»). `ride_request.status` dice
 * se il *sistema* ha accettato la domanda; `ride.status` dice a che punto è il *viaggio*. Una
 * richiesta resta `ACCEPTED` mentre la sua corsa passa da `SCHEDULED` a `IN_PROGRESS` a
 * `COMPLETED`: schiacciare le due cose in una colonna avrebbe reso impossibile distinguere «il
 * sistema ha trovato un veicolo» da «il passeggero è a bordo», che è precisamente ciò che R6
 * chiede di notificare.
 *
 * **`ride_request_id` è `UNIQUE`.** È la cardinalità `1 --> 0..1` della Figura 2.3 del RASD scritta
 * in schema: una richiesta genera al più una corsa. Senza il vincolo, un'attivazione ripetuta ne
 * creerebbe una seconda e il passeggero riceverebbe due volte la stessa progressione.
 *
 * Il punto di ritiro e la destinazione sono **copiati** dalla richiesta invece che raggiunti
 * attraverso di essa, come la Figura 2.3 del RASD modella (`Ride "1" -- "1" Location`). Sono
 * immutabili una volta che la corsa esiste — dove si andava non cambia a corsa iniziata — quindi
 * la copia non è una seconda verità da tenere allineata, è il congelamento del patto fatto col
 * passeggero. Con la sola chiave esterna, una richiesta corretta dopo l'accettazione riscriverebbe
 * a posteriori l'itinerario di una corsa già conclusa.
 */
const values = (allowed: readonly string[]): string =>
  allowed.map((value) => `'${value}'`).join(', ');

export class Ride1786492800000 implements MigrationInterface {
  name = 'Ride1786492800000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "ride" (
        "id"                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "ride_request_id"       uuid NOT NULL UNIQUE REFERENCES "ride_request" ("id") ON DELETE CASCADE,
        "passenger_id"          uuid NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
        "robotaxi_id"           varchar(40) REFERENCES "robotaxi" ("id") ON DELETE SET NULL,
        "status"                varchar(30) NOT NULL CHECK ("status" IN (${values(RIDE_STATUSES)})),
        "pickup_lat"            double precision NOT NULL CHECK ("pickup_lat" BETWEEN -90 AND 90),
        "pickup_lon"            double precision NOT NULL CHECK ("pickup_lon" BETWEEN -180 AND 180),
        "destination_lat"       double precision NOT NULL CHECK ("destination_lat" BETWEEN -90 AND 90),
        "destination_lon"       double precision NOT NULL CHECK ("destination_lon" BETWEEN -180 AND 180),
        "started_at"            timestamptz,
        "ended_at"              timestamptz,
        "created_at"            timestamptz NOT NULL,
        -- Il RASD dà a Ride uno startTime e un endTime: se ci sono entrambi, sono in ordine.
        --
        -- Il vincolo si ferma qui e non pretende anche che una corsa finita sia cominciata, perché
        -- non è vero: una corsa annullata (R14) si chiude senza essere mai partita — il passeggero
        -- disdice mentre il veicolo sta ancora arrivando — e started_at resta giustamente nullo.
        -- Preteso, quel vincolo avrebbe reso impossibile l'annullamento, che è metà di R14.
        CONSTRAINT "ride_period_is_ordered"
          CHECK ("started_at" IS NULL OR "ended_at" IS NULL OR "started_at" <= "ended_at")
      )
    `);

    // La ricerca che il canale push fa più spesso: le corse di un passeggero, dalla più recente.
    await queryRunner.query(
      `CREATE INDEX "ride_passenger_idx" ON "ride" ("passenger_id", "created_at" DESC)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "ride"`);
  }
}
