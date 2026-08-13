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
 *  1. **un evento di domanda attivo in questo momento** allo stadio. Un evento con orari fissi —
 *     come i tre del seed — è utile a un test che governa l'orologio e inutile a una dimostrazione,
 *     che gira quando gira;
 *  2. **il moltiplicatore calcolato sui dati**, non un numero tondo. Il riposizionamento sceglie la
 *     zona più scoperta, quindi perché lo stadio vinca deve battere la domanda di base di tutte le
 *     altre **nella fascia oraria in cui il comando viene eseguito**. Un `6` scritto a mano
 *     funzionerebbe di sera e non a mezzogiorno, quando il centro ha una base sei volte più alta —
 *     e una dimostrazione che riesce solo a certe ore è una dimostrazione che un giorno non riesce;
 *  3. **nessun veicolo allo stadio, tutti disponibili altrove.** Senza una zona davvero scoperta non
 *     c'è deficit, e senza veicoli che avanzino da qualche parte non c'è niente da mandare.
 *
 * È **ripetibile**: rieseguirlo riporta la flotta a posto e riscrive l'evento sull'ora corrente,
 * così una dimostrazione andata storta si ricomincia con un comando solo.
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
 * Di quanto la domanda dello stadio deve superare la zona più affollata.
 *
 * Un margine e non un pareggio: `rankByDeficit` rompe i pareggi sull'`id` crescente, e `san-siro`
 * non è il primo alfabeticamente. Con un fattore due la classifica non dipende da un arrotondamento.
 */
const DOMINANCE_FACTOR = 2;

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
  const busiestBase = Math.max(...samples.map((sample) => sample.baseDemand));
  if (stadiumBase <= 0) {
    throw new Error(
      `La domanda di base dello stadio in questa fascia è ${stadiumBase}: un moltiplicatore non la ` +
        'farebbe crescere. Il seed non dovrebbe produrre zeri — controlla `seed-data.ts`.',
    );
  }

  // Il moltiplicatore che porta lo stadio davanti a tutti, arrotondato per eccesso perché sia un
  // numero leggibile in dashboard invece di `13.428…`.
  const multiplier = Math.ceil((busiestBase * DOMINANCE_FACTOR) / stadiumBase);
  const expectedDemand = stadiumBase * multiplier;

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

  // Le corse aperte della dimostrazione precedente terrebbero occupati dei veicoli che sono appena
  // tornati disponibili: le due verità si contraddirebbero, e la mappa mostrerebbe la seconda.
  await source.query(
    'TRUNCATE TABLE "notification", "rebalancing_action", "ride", "booking", "robotaxi_reservation", "ride_request" RESTART IDENTITY CASCADE',
  );

  const stadium = zoneById(STADIUM_ZONE_ID);
  console.log(
    `Evento: partita a ${stadium?.name ?? STADIUM_ZONE_ID}, moltiplicatore ×${multiplier}`,
  );
  console.log(`Finestra: ${startsAt.toISOString()} → ${endsAt.toISOString()}`);
  console.log(
    `Domanda attesa allo stadio: ${expectedDemand.toFixed(2)} contro ${busiestBase.toFixed(2)} della zona più affollata.`,
  );
  const spostati = relocated === 1 ? '1 spostato' : `${relocated} spostati`;
  console.log(
    `Flotta: ${robotaxis.length} veicoli disponibili su ${MILAN_ZONES.length} zone, ${spostati} fuori dallo stadio.`,
  );
  console.log(
    '\nApri la dashboard e guarda il pannello alert: al primo ciclo di riposizionamento i veicoli\n' +
      'inattivi partono verso San Siro e i marker passano al colore di `REBALANCING`.',
  );
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
