import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `ride.pickup_reached_at`: l'istante in cui il veicolo è arrivato al punto di ritiro (M9).
 *
 * Serve alla decisione D63, che assume che il passeggero salga da sé perché nessun sensore sa dire
 * se qualcuno è salito davvero. Fino a M8 quell'assunzione era espressa in **cicli** — «al giro
 * successivo all'arrivo» — e finché un giro durava dieci secondi la differenza fra un ciclo e una
 * durata non si vedeva. Con la telemetria a mezzo secondo si vede eccome: lo stato `arrived` durava
 * mezzo secondo, cioè il passeggero non faceva in tempo a leggere che il robotaxi era arrivato.
 *
 * L'assunzione è ora espressa in **secondi**, e per valutarla serve sapere da quando il veicolo
 * aspetta. Il dato è una marca temporale della corsa e sta accanto alle altre due che il RASD
 * §2.2.3 le dà, `started_at` ed `ended_at`: `pickup_reached_at` è il momento immediatamente
 * precedente al primo, e le tre insieme sono la cronologia del servizio ricevuto.
 *
 * **Perché non bastava una colonna esistente.** `robotaxi.updated_at` sembra la candidata naturale —
 * la riga si scrive a ogni transizione — ma la telemetria vi registra anche le posizioni, a ogni
 * giro: per un veicolo fermo al ritiro quella marca continuerebbe ad avanzare, e la sosta non
 * scadrebbe mai. Tenere l'istante in memoria nel componente che legge la telemetria era l'altra
 * via, ed è esclusa da due proprietà che `FleetTelemetry` dichiara: nessuna memoria fra un giro e
 * l'altro — è ciò che rende il ciclo riprendibile dopo un riavvio — e un tier applicativo
 * replicabile (NFR3), su cui due repliche avrebbero due memorie diverse.
 *
 * **Nullabile, e resta nulla per le corse già passate.** Non c'è un valore che non inventi una
 * cronologia: una corsa conclusa prima di questa migrazione ha raggiunto il ritiro in un istante
 * che non è stato registrato, e scriverci `started_at` direbbe che la salita è stata istantanea.
 * Chi legge la tratta come «non ancora arrivato al ritiro», che per una corsa conclusa non ha
 * nessuna conseguenza: la sosta si valuta solo su un veicolo in `ARRIVED`.
 */
export class RidePickupReachedAt1786665600000 implements MigrationInterface {
  name = 'RidePickupReachedAt1786665600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ride" ADD COLUMN "pickup_reached_at" timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "ride" DROP COLUMN "pickup_reached_at"`);
  }
}
