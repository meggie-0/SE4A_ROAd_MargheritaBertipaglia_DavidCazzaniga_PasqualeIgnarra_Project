// Il generatore di richieste di corsa della dimostrazione del traffico (decisione D79).
//
// **Passa dall'API pubblica, come l'app passeggero.** Registra i propri passeggeri con
// `POST /auth/register` e chiede le corse con `POST /rides/immediate`: niente di ciò che fa è
// precluso a un client qualunque, e niente scavalca la catena richiesta → candidati → allocazione →
// riserva → assegnazione che si vuole mostrare. Un secondo processo che componesse Nest, o chiamasse
// le porte, muoverebbe un simulatore che nessuno guarda: la flotta vive nella memoria del processo
// dell'API (decisione D64).
//
// **Il seme è fisso**, e la sequenza è una sola: stessi punti di ritiro, stesse destinazioni, stessi
// istanti relativi all'avvio, a ogni esecuzione. Ciò che può variare da un'esecuzione all'altra è
// l'intreccio fra una richiesta e i passi del simulatore — lo stack gira su tempo reale — e quindi,
// a volte, quale veicolo risulta il migliore in quell'istante. La garanzia deterministica della
// proprietà che la demo mostra sta in un test d'integrazione con l'orologio finto, non qui.
//
// Si usa da `tools/demo/run.mjs`, oppure da solo contro uno stack già acceso:
//
//   node tools/demo/ride-requests.mjs            # la sequenza intera, contro http://localhost:3000
//   node tools/demo/ride-requests.mjs --plan     # stampa la sequenza senza chiedere niente

import { pathToFileURL } from 'node:url';

import { MILAN_ZONES, haversineKm, nearestZone } from '../../packages/shared/dist/esm/index.js';

/** Il seme della sequenza. Cambiarlo cambia la storia che la demo racconta: non farlo di passaggio. */
export const DEMO_SEED = 79;

/** Quanti passeggeri si registrano. Le corse li usano a turno. */
const PASSENGERS = 16;

/** La password dei passeggeri della demo: sono account usa e getta, che `db:seed` cancella. */
const PASSENGER_PASSWORD = 'passeggero-della-demo';

/**
 * Il ritmo: da quale secondo, ogni quanti secondi parte una richiesta, che quota va in centro, e se
 * i ritiri in centro vengono dai punti della messa in scena.
 *
 * Quattro fasi, allineate alla tabella del traffico della demo (`LOW:0,MEDIUM:60,HIGH:90,…`):
 *
 * - **0–40 s**, poche richieste sparse: con il traffico basso vince il più vicino, e si vede;
 * - **40–90 s**, il picco comincia e la mappa si riempie, ma **quasi tutto fuori dal centro**. Non è
 *   un dettaglio: con «Più vicino disponibile» ogni ritiro in centro consuma un'auto del centro, e un
 *   centro svuotato prima che il traffico salga non ha più il più vicino da battere. Misurato: con
 *   metà delle venti auto del centro impegnate un ribaltamento su venticinque mostra un distacco
 *   sotto il minuto, con tre quarti uno su sette; con al più cinque, nessuno;
 * - **90–150 s**, il centro è a `HIGH`: quattro ritiri su cinque vanno **ai bordi del centro**, sui
 *   punti di `STAGED_PICKUPS`, dove l'auto di periferia arriva prima di quella del centro. Vincendo
 *   quelle, il centro non si svuota;
 * - **150–190 s**, la città torna quieta.
 */
const RHYTHM = [
  { fromSecond: 0, everySeconds: 6, centreShare: 0.3, staged: false },
  { fromSecond: 40, everySeconds: 3, centreShare: 0.15, staged: false },
  { fromSecond: 90, everySeconds: 3, centreShare: 0.8, staged: true },
  { fromSecond: 150, everySeconds: 5, centreShare: 0.3, staged: false },
];

/**
 * I ritiri del picco: punti **ai bordi del centro, sul lato verso la periferia** (decisione D79).
 *
 * È una messa in scena, come la partita a San Siro di `db:demo`, ed è dichiarata qui e nel README.
 * Il fenomeno che la demo mostra — sotto traffico il più vicino non è il più veloce — nel cuore del
 * centro non esiste: al Duomo qualunque auto venga da fuori deve attraversare il centro per
 * arrivare, e il più vicino vince comunque. Esiste ai bordi, dove un'auto di periferia arriva facendo
 * quasi tutta la strada fuori dalla congestione.
 *
 * Scelti una volta, e non a occhio: su una griglia di 150 metri sul centro, i punti in cui — con la
 * flotta del seed intera, il centro a `HIGH` e un fattore quattro — il più vicino è un'auto del centro
 * e il più veloce un'auto di periferia, **con almeno due minuti di distacco** (nessuno qui sotto sta
 * sotto i tre). Poi, a turno fra le quattro zone di bordo e mai due a meno di 250 metri. La taratura
 * è sul distacco e non sul vincitore: una riga che dice «il più vicino ne avrebbe impiegati 7,9»
 * contro 7,8 non dimostra niente a chi guarda. Se cambia il seed della flotta, questi punti vanno
 * ricalcolati.
 */
const STAGED_PICKUPS = [
  { lat: 45.4625, lon: 9.155 }, // Cadorna
  { lat: 45.4625, lon: 9.221 }, // Porta Venezia
  { lat: 45.4595, lon: 9.224 }, // Porta Romana
  { lat: 45.458, lon: 9.155 }, // Navigli
  { lat: 45.4655, lon: 9.158 }, // Cadorna
  { lat: 45.4655, lon: 9.2195 }, // Porta Venezia
  { lat: 45.461, lon: 9.218 }, // Porta Romana
  { lat: 45.455, lon: 9.155 }, // Navigli
  { lat: 45.479, lon: 9.173 }, // Cadorna
  { lat: 45.4745, lon: 9.191 }, // Porta Venezia
  { lat: 45.4565, lon: 9.224 }, // Porta Romana
  { lat: 45.458, lon: 9.1595 }, // Navigli
  { lat: 45.4775, lon: 9.1775 }, // Cadorna
  { lat: 45.47, lon: 9.218 }, // Porta Venezia
  { lat: 45.458, lon: 9.221 }, // Porta Romana
  { lat: 45.476, lon: 9.182 }, // Cadorna
  { lat: 45.473, lon: 9.2165 }, // Porta Venezia
  { lat: 45.4535, lon: 9.224 }, // Porta Romana
  { lat: 45.4745, lon: 9.185 }, // Cadorna
  { lat: 45.464, lon: 9.2165 }, // Porta Venezia
];

/** Dopo quanti secondi smette di chiedere corse. */
export const REQUESTS_UNTIL_SECOND = 190;

/** Le zone del centro: le stesse che il traffico per zona considera tali (decisione D79). */
const CENTRE_ZONE_IDS = new Set(['duomo', 'cadorna', 'porta-venezia', 'navigli', 'porta-romana']);

/** Quanto lontano dal centroide può cadere un punto, e quanto almeno deve distare la destinazione. */
const SCATTER_KM = 0.7;

/**
 * Quanto è lunga una corsa: fra uno e mezzo e quattro chilometri e mezzo.
 *
 * Corte di proposito. Un'auto torna disponibile solo a corsa finita, e con tragitti di dieci
 * chilometri — che la città permette — la flotta resterebbe impegnata per tutta la dimostrazione:
 * il più vicino diventerebbe un'auto dall'altra parte di Milano, e i ribaltamenti fra due auto
 * lontanissime non racconterebbero niente.
 */
const MIN_TRIP_KM = 1.5;
const MAX_TRIP_KM = 4.5;

/** Mulberry32: trentadue bit di stato, abbastanza per una sequenza che deve solo ripetersi uguale. */
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Un punto nella zona indicata, **che appartenga davvero a quella zona**.
 *
 * Il sistema attribuisce un punto alla zona del centroide più vicino, quindi un punto sparso
 * attorno a un centroide può cadere in quella accanto. Si ripete finché non cade dove si voleva: una
 * richiesta annunciata «in centro» che il sistema considera di Porta Garibaldi falserebbe il
 * racconto della demo proprio nel punto che conta.
 */
function pointIn(zone, random) {
  for (;;) {
    const distanceKm = SCATTER_KM * Math.sqrt(random());
    const bearing = 2 * Math.PI * random();
    const lat = zone.lat + (distanceKm / 111.32) * Math.cos(bearing);
    const lon =
      zone.lon + (distanceKm / (111.32 * Math.cos((zone.lat * Math.PI) / 180))) * Math.sin(bearing);
    const point = { lat: round6(lat), lon: round6(lon) };
    if (nearestZone(point, MILAN_ZONES).id === zone.id) return point;
  }
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function pick(list, random) {
  return list[Math.floor(random() * list.length)];
}

/**
 * La sequenza intera, calcolata prima di chiedere qualunque cosa.
 *
 * Tenerla separata dall'invio è ciò che la rende verificabile: `--plan` la stampa, e due esecuzioni
 * la producono identica senza che serva uno stack acceso per accorgersene.
 */
export function planRideRequests(seed = DEMO_SEED) {
  const random = seededRandom(seed);
  const centre = MILAN_ZONES.filter((zone) => CENTRE_ZONE_IDS.has(zone.id));
  const outskirts = MILAN_ZONES.filter((zone) => !CENTRE_ZONE_IDS.has(zone.id));

  const plan = [];
  let stagedUsed = 0;
  let second = 2;
  while (second < REQUESTS_UNTIL_SECOND) {
    const phase = [...RHYTHM].reverse().find((step) => second >= step.fromSecond) ?? RHYTHM[0];
    const inCentre = random() < phase.centreShare;
    let pickupZone;
    let pickup;
    if (inCentre && phase.staged) {
      pickup = STAGED_PICKUPS[stagedUsed % STAGED_PICKUPS.length];
      stagedUsed += 1;
      pickupZone = nearestZone(pickup, MILAN_ZONES);
    } else {
      pickupZone = pick(inCentre ? centre : outskirts, random);
      pickup = pointIn(pickupZone, random);
    }

    // La destinazione si sceglie fra le zone il cui centro cade nella fascia di lunghezza. Non
    // ritentando a caso: da Rho Fiera o da Linate nessuna zona sta a meno di cinque chilometri, e un
    // ciclo che aspettasse un punto nella fascia non terminerebbe. Lì si ripiega sulla più vicina.
    const others = MILAN_ZONES.filter((zone) => zone.id !== pickupZone.id);
    const inRange = others.filter((zone) => {
      const km = haversineKm(pickup, zone);
      return km >= MIN_TRIP_KM && km <= MAX_TRIP_KM;
    });
    const destinationZone =
      inRange.length > 0
        ? pick(inRange, random)
        : others.reduce((best, zone) =>
            haversineKm(pickup, zone) < haversineKm(pickup, best) ? zone : best,
          );
    const destination = pointIn(destinationZone, random);

    plan.push({
      index: plan.length + 1,
      atSecond: second,
      passenger: plan.length % PASSENGERS,
      pickupZone: pickupZone.id,
      pickupZoneName: pickupZone.name,
      inCentre,
      pickup,
      destinationZone: destinationZone.id,
      destinationZoneName: destinationZone.name,
      destination,
    });
    second += phase.everySeconds;
  }
  return plan;
}

function passengerEmail(index) {
  return `demo.passeggero.${String(index + 1).padStart(2, '0')}@road.example`;
}

async function post(apiBaseUrl, path, body, token) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Una risposta senza corpo JSON resta `null`: chi chiama guarda lo stato.
  }
  return { status: response.status, json };
}

/**
 * Un passeggero pronto a chiedere corse: registrato, o — se esiste già — autenticato.
 *
 * Il secondo caso non è teorico: chi rilancia il generatore contro uno stack già acceso, senza un
 * `db:seed` in mezzo, trova gli account della volta prima.
 */
async function signIn(apiBaseUrl, index) {
  const email = passengerEmail(index);
  const registered = await post(apiBaseUrl, '/auth/register', {
    email,
    password: PASSENGER_PASSWORD,
    name: 'Passeggero',
    surname: `Demo ${index + 1}`,
  });
  if (registered.status === 201) return registered.json.accessToken;

  const login = await post(apiBaseUrl, '/auth/login', { email, password: PASSENGER_PASSWORD });
  if (login.status === 200) return login.json.accessToken;

  throw new Error(
    `Passeggero ${email}: registrazione ${registered.status}, accesso ${login.status}.`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Esegue la sequenza contro l'API, e restituisce l'esito di ogni richiesta.
 *
 * L'orologio della sequenza parte **qui**, dopo la registrazione dei passeggeri: le prime richieste
 * non devono pagare il tempo di bcrypt, o arriverebbero tutte insieme.
 */
export async function runRideRequests({
  apiBaseUrl = 'http://localhost:3000',
  seed = DEMO_SEED,
  log = console.log,
} = {}) {
  const plan = planRideRequests(seed);

  const tokens = [];
  for (let index = 0; index < PASSENGERS; index += 1) tokens.push(await signIn(apiBaseUrl, index));

  const startedAt = Date.now();
  const outcomes = [];

  for (const request of plan) {
    const wait = startedAt + request.atSecond * 1000 - Date.now();
    if (wait > 0) await sleep(wait);

    const sentAtSecond = (Date.now() - startedAt) / 1000;
    const response = await post(
      apiBaseUrl,
      '/rides/immediate',
      {
        pickup: request.pickup,
        pickupAddress: request.pickupZoneName,
        destination: request.destination,
        destinationAddress: request.destinationZoneName,
      },
      tokens[request.passenger],
    );

    const robotaxiId = response.json?.assignedRobotaxiId ?? null;
    const outcome = {
      ...request,
      sentAtSecond,
      status: response.status,
      rideStatus: response.json?.status ?? null,
      robotaxiId,
    };
    outcomes.push(outcome);

    const where = `${request.pickupZoneName}${request.inCentre ? ' (centro)' : ''} → ${request.destinationZoneName}`;
    const result =
      robotaxiId !== null
        ? robotaxiId
        : response.status === 201
          ? 'nessun veicolo idoneo'
          : `HTTP ${response.status}`;
    log(
      `  t+${sentAtSecond.toFixed(0).padStart(3)}s  corsa ${String(request.index).padStart(2)}  ${where.padEnd(44)} ${result}`,
    );
  }

  return outcomes;
}

// Da riga di comando.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--plan')) {
    for (const request of planRideRequests()) {
      console.log(
        `t+${String(request.atSecond).padStart(3)}s  ${String(request.index).padStart(2)}  ` +
          `${request.pickupZone.padEnd(20)} → ${request.destinationZone.padEnd(20)} ` +
          `${request.pickup.lat},${request.pickup.lon}`,
      );
    }
  } else {
    const outcomes = await runRideRequests();
    const assigned = outcomes.filter((outcome) => outcome.robotaxiId !== null).length;
    console.log(`\n${outcomes.length} richieste, ${assigned} assegnate.`);
  }
}
