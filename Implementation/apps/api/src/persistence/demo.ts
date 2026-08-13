import { MILAN_ZONES, milanWeekdayHourSlot, zoneById } from '@road/shared';

import { ClockPort } from '../platform/clock.port';

import { runCommand } from './cli-context';
import { Database } from './database';
import { PersistencePort } from './persistence.port';

/**
 * `pnpm db:demo` — **la serata con la partita a San Siro** (MILESTONES.md §M9).
 *
 * È il dataset di dimostrazione della milestone, e serve a far vedere in due minuti la cosa che
 * altrimenti richiederebbe di aspettare che la città si comporti in un certo modo: lo scenario 4 del
 * RASD, cioè il riposizionamento proattivo verso una zona di domanda prevista.
 *
 * **Si esegue dopo `pnpm db:seed`, non al suo posto.** Il seed costruisce la città — zone, flotta,
 * una settimana di domanda di base, gli account; questo comando ci mette sopra una sera. Tenere le
 * due cose separate ha una ragione pratica: il seed è il punto di partenza di ogni verifica e non
 * deve cambiare a seconda di che ora è, mentre una dimostrazione ha senso solo **adesso**.
 *
 * Che cosa arrangia, e perché ciascuna cosa:
 *
 *  1. **un evento di domanda attivo in questo momento** allo stadio, con il moltiplicatore ricavato
 *     dalla base storica della fascia. Un evento con orari fissi — come i tre del seed — è utile a
 *     un test che governa l'orologio e inutile a una dimostrazione, che gira quando gira;
 *  2. **una serata tranquilla nelle altre zone**, riscrivendo la domanda di base della sola fascia
 *     corrente (`QUIET_DEMAND`). Non è un abbellimento: senza, non c'è **niente da mandare**, e la
 *     dimostrazione non mostrerebbe nulla a qualunque ora la si tenga;
 *  3. **nessun veicolo allo stadio, tutti disponibili altrove.** Senza una zona davvero scoperta non
 *     c'è deficit, e senza veicoli che avanzino da qualche parte non c'è niente da mandare.
 *
 * È **ripetibile**: rieseguirlo riporta la flotta a posto e riscrive l'evento sull'ora corrente,
 * così una dimostrazione andata storta si ricomincia con un comando solo. Con l'API **in
 * esecuzione** però non basta: il mondo del simulatore vive nella memoria di quel processo
 * (decisione D64) e questo comando non lo raggiunge, quindi i veicoli che stavano percorrendo una
 * rotta la riprendono e la telemetria riscrive le loro posizioni entro mezzo secondo. Va eseguito a
 * `pnpm dev` fermo, e il README lo dice.
 *
 * L'ora viene da `ClockPort` e non da `new Date()` (CLAUDE.md Regola 3), come ovunque.
 */

/** La zona dell'evento: lo stadio del RASD §2.1, scenario 4. */
const STADIUM_ZONE_ID = 'san-siro';

/** Dove finiscono i veicoli che il seed aveva lasciato allo stadio. */
const RELOCATION_ZONE_ID = 'duomo';

/** L'evento comincia mezz'ora fa e dura due ore: la partita è appena finita. */
const STARTED_MINUTES_AGO = 30;
const LASTS_MINUTES = 120;

/**
 * Quante corse ci si aspetta allo stadio a fine partita.
 *
 * È il numero da cui si ricava il moltiplicatore dell'evento, dividendo per la base storica della
 * fascia: sei, perché è la scala che tiene lo stadio in deficit per parecchi cicli di
 * riposizionamento di seguito, e un ciclo manda un veicolo per zona scoperta.
 */
const STADIUM_EXPECTED_RIDES = 6;

/**
 * La domanda che resta alle **altre** zone nella fascia della dimostrazione.
 *
 * Al più una corsa attesa, e mai più dei veicoli che la zona già ha. Le due condizioni fanno due
 * cose diverse e servono entrambe:
 *
 * - **al più una** lascia a ogni zona con più di un veicolo qualcosa da cedere. Una zona tiene per
 *   sé quanto basta a coprire la propria domanda arrotondata per eccesso e presta il resto
 *   (`RebalancingManager`), quindi senza abbassare la domanda non ci sarebbe **niente da mandare**;
 * - **mai più dei veicoli che ha** impedisce a una zona vuota di finire anch'essa in deficit e di
 *   contendere allo stadio i veicoli del ciclo. Lo stadio dev'essere l'unica zona scoperta, o metà
 *   dei veicoli partirebbe per un'altra destinazione e la dimostrazione racconterebbe un'altra cosa.
 *
 * **Perché la domanda va riscritta e non basta l'evento.** Con i profili del seed — che sono in
 * corse attese per ora, e arrivano a diciotto in centro — venti veicoli su sedici zone non bastano
 * a coprire nemmeno la domanda di base: fra le sette del mattino e le undici di sera il surplus è
 * **zero in ogni zona**, quindi `rebalance()` non avrebbe un solo veicolo da spostare e la
 * dimostrazione, a qualunque ora la si tenga, non mostrerebbe nulla. Il moltiplicatore da solo
 * sposta la classifica, non crea i veicoli da mandare.
 *
 * Il che descrive una serata tranquilla, che è esattamente la scena del RASD §2.1 scenario 4:
 * «several idle robotaxis scattered in **low-demand** areas of the city».
 */
const QUIET_DEMAND = 1;

const MINUTE_MS = 60_000;

runCommand(async (context) => {
  const persistence = context.get(PersistencePort);
  const clock = context.get(ClockPort);
  const source = await context.get(Database).connection();

  const now = clock.now();
  const slot = milanWeekdayHourSlot(now);

  const robotaxis = await persistence.find('robotaxi', {});
  if (robotaxis.length === 0) {
    throw new Error(
      'Nessun robotaxi in flotta: esegui prima `pnpm db:seed`, poi `pnpm db:demo`. ' +
        'Questo comando arrangia una serata sulla città che il seed ha costruito, non la crea.',
    );
  }

  /*
   * La domanda di base della fascia corrente, zona per zona.
   *
   * Serve a scegliere il moltiplicatore, e si legge invece di ricalcolarla: la sede autorevole di
   * quel numero è `demand_sample`, che il seed ha scritto, e ricostruirlo qui significherebbe avere
   * due modelli di domanda che possono divergere.
   */
  const samples = await persistence.find('demand_sample', {
    where: { dayOfWeek: slot.dayOfWeek, hourOfDay: slot.hourOfDay },
  });
  if (samples.length === 0) {
    throw new Error(
      `Nessun campione di domanda per la fascia corrente (giorno ${slot.dayOfWeek}, ora ${slot.hourOfDay}): ` +
        'esegui `pnpm db:seed`.',
    );
  }

  const stadiumBase = samples.find((sample) => sample.zoneId === STADIUM_ZONE_ID)?.baseDemand ?? 0;
  if (stadiumBase <= 0) {
    throw new Error(
      `La domanda di base dello stadio in questa fascia è ${stadiumBase}: un moltiplicatore non la ` +
        'farebbe crescere. Il seed non dovrebbe produrre zeri — controlla `seed-data.ts`.',
    );
  }

  // Il moltiplicatore che porta lo stadio alla domanda di fine partita, arrotondato per eccesso
  // perché sia un numero leggibile in dashboard invece di `13.428…`.
  const multiplier = Math.ceil(STADIUM_EXPECTED_RIDES / stadiumBase);
  const expectedDemand = stadiumBase * multiplier;

  /*
   * La serata tranquilla: la domanda delle altre zone scende a quanto possono già coprire.
   *
   * Si riscrive **solo la fascia oraria corrente** e **solo le zone diverse dallo stadio**: il resto
   * della settimana resta il profilo storico che il seed ha costruito, e la base dello stadio resta
   * la sua — è quella che, moltiplicata, produce il picco. Riscrivere l'intera tabella avrebbe
   * cancellato il modello di domanda per mettere al suo posto una scena.
   */
  const fleetByZone = new Map<string, number>();
  for (const robotaxi of robotaxis) {
    const zoneId = robotaxi.zoneId === STADIUM_ZONE_ID ? RELOCATION_ZONE_ID : robotaxi.zoneId;
    if (zoneId === null) continue;
    fleetByZone.set(zoneId, (fleetByZone.get(zoneId) ?? 0) + 1);
  }

  let quieted = 0;
  for (const sample of samples) {
    if (sample.zoneId === STADIUM_ZONE_ID) continue;

    const quiet = Math.min(QUIET_DEMAND, fleetByZone.get(sample.zoneId) ?? 0);
    if (sample.baseDemand === quiet) continue;

    await persistence.update('demand_sample', sample.id, { baseDemand: quiet });
    quieted += 1;
  }

  const startsAt = new Date(now.getTime() - STARTED_MINUTES_AGO * MINUTE_MS);
  const endsAt = new Date(startsAt.getTime() + LASTS_MINUTES * MINUTE_MS);

  // Gli eventi si riscrivono da capo: se restassero quelli del seed — o quello della dimostrazione
  // precedente — la classifica delle zone dipenderebbe da quante volte il comando è stato eseguito.
  await source.query('TRUNCATE TABLE "demand_event" RESTART IDENTITY CASCADE');
  await persistence.create('demand_event', {
    zoneId: STADIUM_ZONE_ID,
    name: 'Partita di campionato a San Siro',
    startsAt,
    endsAt,
    multiplier,
  });

  /*
   * La flotta torna al punto di partenza, e **fuori dallo stadio**.
   *
   * Si scrive la colonna di stato invece di far passare i veicoli dalle transizioni, ed è la stessa
   * cosa che fa il seed quando crea venti righe `AVAILABLE`: qui non si sta gestendo una flotta, si
   * sta *preparando* una situazione iniziale. Una dimostrazione che cominciasse con tre veicoli in
   * corsa dalla volta precedente non mostrerebbe il riposizionamento, mostrerebbe il residuo.
   */
  let relocated = 0;
  for (const robotaxi of robotaxis) {
    const targetZoneId = robotaxi.zoneId === STADIUM_ZONE_ID ? RELOCATION_ZONE_ID : robotaxi.zoneId;
    const home = targetZoneId === null ? undefined : zoneById(targetZoneId);
    if (home === undefined) continue;

    if (robotaxi.zoneId === STADIUM_ZONE_ID) relocated += 1;

    await persistence.update('robotaxi', robotaxi.id, {
      state: 'AVAILABLE',
      zoneId: home.id,
      lat: home.lat,
      lon: home.lon,
    });
  }

  /*
   * Ciò che la dimostrazione precedente ha lasciato aperto.
   *
   * Le corse terrebbero occupati dei veicoli che sono appena tornati disponibili, e le due verità si
   * contraddirebbero. `maintenance_record` sta nell'elenco per una ragione più stretta: un veicolo
   * messo in manutenzione dalla dashboard (R9) ha una riga **aperta**, e il ciclo qui sopra gli ha
   * appena riscritto la colonna a `AVAILABLE`. Lasciandola, quell'intervento non si potrebbe più
   * chiudere — `completeMaintenance()` è ammessa solo da `MAINTENANCE` — e resterebbe aperto per
   * sempre su un veicolo che circola.
   */
  await source.query(
    'TRUNCATE TABLE "notification", "rebalancing_action", "ride", "booking", "robotaxi_reservation", "ride_request", "maintenance_record" RESTART IDENTITY CASCADE',
  );

  const stadium = zoneById(STADIUM_ZONE_ID);
  const spare = [...fleetByZone.entries()]
    .filter(([zoneId]) => zoneId !== STADIUM_ZONE_ID)
    .reduce((total, [, vehicles]) => {
      const quiet = Math.min(QUIET_DEMAND, vehicles);
      return total + Math.max(0, vehicles - Math.ceil(quiet));
    }, 0);

  console.log(
    `Evento: partita a ${stadium?.name ?? STADIUM_ZONE_ID}, moltiplicatore ×${multiplier}`,
  );
  console.log(`Finestra: ${startsAt.toISOString()} → ${endsAt.toISOString()}`);
  console.log(
    `Domanda attesa allo stadio: ${expectedDemand.toFixed(2)}, contro al più ${QUIET_DEMAND} nelle altre zone (${quieted} campioni riscritti).`,
  );
  const spostati = relocated === 1 ? '1 spostato' : `${relocated} spostati`;
  console.log(
    `Flotta: ${robotaxis.length} veicoli disponibili su ${MILAN_ZONES.length} zone, ${spostati} fuori dallo stadio.`,
  );
  // Il numero che dice se la dimostrazione mostrerà qualcosa: senza veicoli cedibili non parte
  // nessuno, per quanto alta sia la domanda allo stadio.
  console.log(`Veicoli cedibili dalle zone in surplus: ${spare}.`);
  console.log(
    '\nApri la dashboard e guarda il pannello alert: a ogni ciclo di riposizionamento un veicolo\n' +
      'inattivo parte verso San Siro e il suo marker passa al colore di `REBALANCING`.',
  );
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
