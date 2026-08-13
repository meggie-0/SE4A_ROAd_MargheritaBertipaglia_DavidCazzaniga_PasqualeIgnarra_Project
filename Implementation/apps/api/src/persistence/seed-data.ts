import { MILAN_ZONES, zoneById } from '@road/shared';

import type { NewRecord } from './persistence.port';

/**
 * I dati di partenza del prototipo (MILESTONES.md §M1): le 16 zone di Milano, 64 robotaxi, una
 * settimana di domanda di base e tre eventi di esempio.
 *
 * L'elenco delle zone non è qui ma in `@road/shared`: lo usano anche `nearestZone()` e, da M8, la
 * mappa della dashboard. Qui ci sono il *profilo di domanda* di ciascuna zona e la flotta, che
 * riguardano solo il seed del backend.
 *
 * **I dati di domanda sono simulati.** Il RASD §2.6 tratta la sorgente di domanda come una
 * dipendenza esterna: finché M7 non collega un fornitore vero, questo file la sostituisce. È
 * un'assunzione dichiarata, non una scorciatoia nascosta.
 *
 * Tutto qui dentro è deterministico: nessun valore casuale, nessuna lettura dell'orologio. Due
 * seed della stessa versione producono lo stesso database, che è la premessa perché un test che
 * fallisce indichi un difetto e non una coincidenza.
 */

// ---------------------------------------------------------------------------------------------
// Profili di domanda
// ---------------------------------------------------------------------------------------------

/**
 * Corse attese per ora del giorno, dalle 00 alle 23, nei giorni feriali e nel fine settimana.
 * Sono gli archetipi che la tabella di MILESTONES.md §M1 descrive a parole.
 */
export interface DemandProfile {
  readonly weekday: readonly number[];
  readonly weekend: readonly number[];
}

/** Centro storico: alta e costante nelle ore diurne. */
const CENTRAL: DemandProfile = {
  weekday: [2, 1, 1, 1, 1, 2, 4, 8, 12, 14, 15, 15, 16, 16, 15, 15, 16, 18, 18, 16, 12, 9, 6, 3],
  weekend: [4, 3, 2, 1, 1, 1, 2, 3, 5, 8, 11, 13, 15, 15, 14, 14, 15, 16, 17, 18, 16, 13, 10, 7],
};

/** Stazione: picchi la mattina presto e la sera, quando arrivano e partono i treni. */
const STATION: DemandProfile = {
  weekday: [2, 1, 1, 1, 2, 6, 14, 18, 16, 10, 8, 8, 9, 9, 9, 10, 12, 16, 18, 16, 11, 7, 5, 3],
  weekend: [3, 2, 1, 1, 1, 3, 7, 10, 11, 10, 9, 9, 10, 10, 10, 11, 12, 14, 15, 14, 11, 8, 6, 4],
};

/** Nodo pendolare: due punte nette, in entrata e in uscita. */
const COMMUTER: DemandProfile = {
  weekday: [1, 1, 0.5, 0.5, 1, 4, 10, 16, 14, 7, 5, 5, 6, 6, 6, 7, 10, 15, 14, 9, 5, 3, 2, 1],
  weekend: [2, 1, 1, 0.5, 0.5, 1, 2, 3, 4, 5, 6, 6, 7, 7, 7, 7, 8, 8, 8, 7, 5, 4, 3, 2],
};

/** Quartiere di uffici: si riempie e si svuota alle ore di punta, quasi deserto nel fine settimana. */
const OFFICE: DemandProfile = {
  weekday: [0.5, 0.5, 0.5, 0.5, 0.5, 2, 6, 12, 13, 8, 6, 6, 7, 7, 6, 6, 8, 13, 12, 7, 3, 2, 1, 1],
  weekend: [1, 1, 0.5, 0.5, 0.5, 0.5, 1, 2, 3, 4, 5, 6, 6, 6, 6, 6, 6, 6, 5, 4, 3, 2, 2, 1],
};

/** Zona serale: cresce dopo cena. */
const EVENING: DemandProfile = {
  weekday: [2, 1, 1, 0.5, 0.5, 1, 2, 4, 5, 4, 4, 4, 5, 5, 5, 5, 6, 8, 11, 13, 12, 10, 7, 4],
  weekend: [5, 4, 3, 2, 1, 1, 1, 2, 3, 4, 5, 5, 6, 6, 6, 6, 7, 9, 12, 15, 15, 13, 10, 7],
};

/** Vita notturna: il picco è a notte fonda, e nel fine settimana è molto più forte. */
const NIGHTLIFE: DemandProfile = {
  weekday: [3, 2, 1, 1, 0.5, 0.5, 1, 2, 3, 3, 3, 4, 5, 5, 4, 4, 5, 7, 10, 13, 14, 13, 10, 6],
  weekend: [9, 7, 5, 3, 2, 1, 1, 1, 2, 3, 4, 5, 6, 6, 6, 6, 7, 9, 13, 17, 19, 18, 15, 12],
};

/** Campus universitario: segue gli orari di lezione e si spegne nel fine settimana. */
const CAMPUS: DemandProfile = {
  weekday: [
    0.5, 0.5, 0.5, 0.5, 0.5, 1, 3, 8, 12, 10, 9, 9, 10, 10, 10, 9, 8, 7, 5, 3, 2, 1, 1, 0.5,
  ],
  weekend: [1, 1, 0.5, 0.5, 0.5, 0.5, 1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1],
};

/** Aeroporto: a ondate, legate ai voli, senza una vera notte morta. */
const AIRPORT: DemandProfile = {
  weekday: [1, 0.5, 0.5, 0.5, 1, 4, 8, 9, 7, 8, 9, 8, 7, 8, 9, 8, 7, 9, 10, 9, 7, 5, 3, 2],
  weekend: [2, 1, 0.5, 0.5, 1, 3, 6, 8, 7, 7, 8, 8, 7, 7, 8, 8, 7, 8, 9, 9, 7, 5, 4, 3],
};

/**
 * Impianto per eventi: base bassa e piatta. Il picco non sta qui — arriva da `demand_event`, che
 * è esattamente il punto del modello a due livelli (decisione D12).
 */
const VENUE: DemandProfile = {
  weekday: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1],
  weekend: [1, 1, 0.5, 0.5, 0.5, 0.5, 1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 1],
};

/** Il profilo di ciascuna zona e quanto pesa rispetto al suo archetipo (`0.1` = dieci volte meno). */
interface ZoneDemand {
  readonly profile: DemandProfile;
  readonly scale: number;
}

/**
 * Quanta della domanda archetipica il prototipo simula.
 *
 * Gli archetipi qui sopra descrivono la *forma* della giornata — quando una zona si riempie e
 * quando si svuota — su una scala che è quella di una città vera. Questo fattore la porta alla
 * scala della **flotta del prototipo**, che è di sessantaquattro veicoli: senza, la domanda di
 * base supererebbe il numero di veicoli in ogni zona e a ogni ora, nessuna zona avrebbe mai un
 * veicolo da cedere, e il riposizionamento — che presta solo ciò che a una zona avanza — non
 * avrebbe **mai** niente da spostare fra le sette del mattino e le undici di sera.
 *
 * Non è un dettaglio di taratura: era il motivo per cui R11 funzionava nei test e non si vedeva
 * mai nel sistema in esecuzione (decisione D73).
 */
const DEMAND_LEVEL = 0.5;

/**
 * La colonna "profilo di domanda" della tabella di MILESTONES.md §M1, tradotta in numeri.
 *
 * **Le scale sono volutamente molto distanti fra loro**, ed è la scelta che rende osservabile il
 * riposizionamento. Tre zone fanno da calamita — il centro, la stazione e i Navigli la sera —
 * mentre il resto della città chiede dieci volte meno; la flotta invece parte **distribuita in
 * modo uniforme**, quattro veicoli per zona. Così ogni squilibrio che si vede sulla mappa viene
 * dalla domanda e non da dove sono stati parcheggiati i veicoli, che è esattamente ciò che il
 * riposizionamento dovrebbe correggere (R11, G9).
 *
 * I due impianti per eventi — stadio e polo fieristico — hanno una scala **alta** con una forma
 * piatta e bassa: fuori dagli eventi non ci va quasi nessuno, e il picco arriva da `demand_event`,
 * che è il punto del modello a due livelli (decisione D12). La scala alta serve a un'altra cosa: a
 * tenere la loro base sopra lo zero, perché un moltiplicatore su una base microscopica dovrebbe
 * valere centinaia per contare qualcosa.
 */
export const ZONE_DEMAND: Readonly<Record<string, ZoneDemand>> = {
  // Le tre calamite.
  duomo: { profile: CENTRAL, scale: 1 },
  'stazione-centrale': { profile: STATION, scale: 0.9 },
  navigli: { profile: NIGHTLIFE, scale: 0.8 },
  // Gli impianti per eventi: base bassa e piatta, picco dall'evento.
  'san-siro': { profile: VENUE, scale: 1.2 },
  'rho-fiera': { profile: VENUE, scale: 1 },
  // Il resto della città: tranquillo, e con veicoli da prestare.
  linate: { profile: AIRPORT, scale: 0.3 },
  'porta-garibaldi': { profile: COMMUTER, scale: 0.15 },
  citylife: { profile: OFFICE, scale: 0.15 },
  'politecnico-leonardo': { profile: CAMPUS, scale: 0.15 },
  'porta-venezia': { profile: EVENING, scale: 0.15 },
  cadorna: { profile: COMMUTER, scale: 0.15 },
  isola: { profile: EVENING, scale: 0.1 },
  'politecnico-bovisa': { profile: CAMPUS, scale: 0.1 },
  bicocca: { profile: CAMPUS, scale: 0.1 },
  lambrate: { profile: COMMUTER, scale: 0.1 },
  'porta-romana': { profile: EVENING, scale: 0.1 },
};

// ---------------------------------------------------------------------------------------------
// Zone e flotta
// ---------------------------------------------------------------------------------------------

/** Le 16 zone, nella forma che la porta accetta. */
export const ZONE_RECORDS: readonly NewRecord<'zone'>[] = MILAN_ZONES.map((zone) => ({
  id: zone.id,
  name: zone.name,
  lat: zone.lat,
  lon: zone.lon,
}));

/**
 * Quanti robotaxi parte da ciascuna zona: **quattro, ovunque**.
 *
 * La distribuzione uniforme è una scelta, non una semplificazione. Il riposizionamento esiste per
 * correggere lo scarto fra dove sono i veicoli e dove serviranno; se la flotta partisse già
 * distribuita secondo la domanda, quello scarto sarebbe zero e non ci sarebbe niente da osservare.
 * Partendo uniforme, **ogni squilibrio che si vede sulla mappa viene dalla domanda** — che è
 * sbilanciata di proposito (vedi `ZONE_DEMAND`) — e non da dove qualcuno ha parcheggiato i veicoli.
 *
 * Sedici zone per quattro fanno **sessantaquattro veicoli**. Sono più dei venti di partenza, e la
 * ragione è la stessa della scala della domanda: con venti, dopo che ogni zona si è tenuta quanto
 * le serve, non ne avanzava nessuno da prestare (decisione D73).
 */
const ROBOTAXIS_PER_ZONE = 4;

/**
 * I quattro scostamenti dal centroide, uno per angolo.
 *
 * Circa 110 metri, contro distanze fra centroidi dell'ordine del chilometro: i veicoli restano
 * ampiamente dentro la cella di Voronoi della propria zona, così la zona dichiarata e quella che
 * `nearestZone()` calcola dalla posizione coincidono — cosa che il cancello di M1 verifica veicolo
 * per veicolo. Sono valori fissi e non casuali: due seed devono produrre la stessa flotta.
 */
const FLEET_OFFSETS: readonly { readonly lat: number; readonly lon: number }[] = [
  { lat: 0.001, lon: 0.001 },
  { lat: 0.001, lon: -0.001 },
  { lat: -0.001, lon: 0.001 },
  { lat: -0.001, lon: -0.001 },
];

/** I 64 robotaxi, tutti `AVAILABLE`, quattro attorno al centroide di ciascuna zona. */
export function fleetRecords(): readonly NewRecord<'robotaxi'>[] {
  const records: NewRecord<'robotaxi'>[] = [];

  for (const zone of MILAN_ZONES) {
    const home = zoneById(zone.id);
    if (home === undefined) throw new Error(`Zona sconosciuta nel seed della flotta: ${zone.id}`);

    for (let index = 0; index < ROBOTAXIS_PER_ZONE; index += 1) {
      // `FLEET_OFFSETS` ha `ROBOTAXIS_PER_ZONE` elementi: l'indice è sempre dentro.
      const offset = FLEET_OFFSETS[index] as (typeof FLEET_OFFSETS)[number];
      records.push({
        id: `RT-${String(records.length + 1).padStart(2, '0')}`,
        state: 'AVAILABLE',
        lat: roundCoordinate(home.lat + offset.lat),
        lon: roundCoordinate(home.lon + offset.lon),
        zoneId: zone.id,
      });
    }
  }

  return records;
}

// ---------------------------------------------------------------------------------------------
// Domanda
// ---------------------------------------------------------------------------------------------

const WEEKEND_DAYS = new Set([0, 6]); // 0 = domenica, 6 = sabato

/** Una settimana di domanda di base: 16 zone × 7 giorni × 24 ore. */
export function demandSampleRecords(): readonly NewRecord<'demand_sample'>[] {
  const samples: NewRecord<'demand_sample'>[] = [];

  for (const zone of MILAN_ZONES) {
    const demand = ZONE_DEMAND[zone.id];
    if (demand === undefined) throw new Error(`Zona senza profilo di domanda: ${zone.id}`);

    for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
      const hours = WEEKEND_DAYS.has(dayOfWeek) ? demand.profile.weekend : demand.profile.weekday;
      for (let hourOfDay = 0; hourOfDay < 24; hourOfDay += 1) {
        samples.push({
          zoneId: zone.id,
          dayOfWeek,
          hourOfDay,
          baseDemand: round((hours[hourOfDay] ?? 0) * demand.scale * DEMAND_LEVEL),
        });
      }
    }
  }

  return samples;
}

/**
 * Tre eventi di esempio, con orari fissi.
 *
 * Servono a mostrare il secondo livello del modello di domanda e sono il materiale della demo di
 * M9 ("una serata con partita a San Siro"). Un evento è attivo in `[startsAt, endsAt)`.
 */
export const DEMAND_EVENT_RECORDS: readonly NewRecord<'demand_event'>[] = [
  {
    zoneId: 'san-siro',
    name: 'Partita di campionato a San Siro',
    startsAt: new Date('2026-09-12T18:45:00.000Z'),
    endsAt: new Date('2026-09-12T22:30:00.000Z'),
    multiplier: 6,
  },
  {
    zoneId: 'rho-fiera',
    name: 'Salone internazionale a Rho Fiera',
    startsAt: new Date('2026-09-15T07:00:00.000Z'),
    endsAt: new Date('2026-09-19T19:00:00.000Z'),
    multiplier: 4,
  },
  {
    zoneId: 'duomo',
    name: 'Prima serale al Teatro alla Scala',
    startsAt: new Date('2026-09-18T18:00:00.000Z'),
    endsAt: new Date('2026-09-18T22:00:00.000Z'),
    multiplier: 2,
  },
];

/** Due decimali: la domanda è una stima, non una misura, e i confronti restano esatti. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Sei decimali: circa dieci centimetri.
 *
 * Le coordinate **non** possono usare `round()`, e per un motivo che vale la pena scrivere perché è
 * stato un difetto vero: due decimali su un grado sono **più di un chilometro**, cioè più della
 * distanza fra due centroidi vicini. Applicato alle posizioni, quell'arrotondamento incollava i
 * veicoli a una griglia grossolana e poteva spostarne uno nella cella di Voronoi della zona
 * accanto — rendendo falsa la `zone_id` scritta in tabella, che è il dato su cui il
 * riposizionamento decide. Il seed precedente lo faceva e passava per coincidenza: con quattro
 * veicoli per zona la coincidenza è finita, e il cancello di M1 — che confronta la zona dichiarata
 * con quella calcolata, veicolo per veicolo — lo ha colto subito.
 */
function roundCoordinate(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
