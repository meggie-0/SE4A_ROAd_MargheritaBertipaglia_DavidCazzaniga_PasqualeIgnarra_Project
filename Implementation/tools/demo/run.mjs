// `pnpm demo:<scenario>` — una dimostrazione riproducibile, dal database allo screenshot.
//
// Uno script solo per tutti gli scenari: cambia l'ambiente, non la procedura. Ogni scenario
// prepara gli stessi dati, alza gli stessi tre servizi e guida lo stesso browser; ciò che lo
// distingue è quali manopole gira (decisione D76).
//
// **Non è un runner nuovo.** Lo stack lo alza `pnpm dev` attraverso il `webServer` di Playwright,
// che è già il modo in cui gli scenari end-to-end si eseguono: qui si preparano i dati e si passa
// l'ambiente. Playwright fonde `process.env` nell'ambiente del figlio, quindi le variabili
// impostate qui raggiungono l'API senza altro cablaggio.

import { createServer } from 'node:net';

import { run, runOrExit, buildPackages, colors } from '../lib/run.mjs';

/**
 * Gli scenari, e le sole cose che li distinguono.
 *
 * `SIMULATOR_TICK_SECONDS` accelera il mondo simulato: 45 secondi di mondo ogni mezzo secondo reale
 * fanno un fattore 90, con cui un ritiro dentro Milano si raggiunge in una decina di secondi. Non
 * rende il sistema dipendente dal tempo — cambia quanti tick servono, non quale veicolo viene
 * scelto né in quale ordine avvengono le transizioni.
 *
 * Le cadenze degli scheduler sono espressioni cron a sei campi, quindi possono scendere sotto il
 * minuto: una che comincia con «asterisco barra dieci» sui secondi vale «ogni dieci secondi». In
 * esecuzione normale restano cinque minuti, dieci minuti e un minuto.
 */
const SCENARIOS = {
  immediate: {
    guida: {
      apri: ['App passeggero  http://localhost:5174', 'Dashboard operatore  http://localhost:5173'],
      guarda: [
        'Nell’app passeggero: accedi, tocca la mappa per il ritiro e per la destinazione, chiedi la corsa.',
        'Il pannello passa a vista di stato e segue assegnazione, avvicinamento, ritiro e corsa.',
        'Sulla dashboard: il conteggio «Disponibili» cala di uno, «In corsa» sale, e il log operativo',
        'mostra le transizioni del veicolo mentre accadono — senza ricaricare niente (NFR2).',
      ],
    },
    scripted: true,
    title: 'Scenario 1 — corsa immediata',
    grep: 'Scenario 1',
    dataset: 'seed',
    env: { SIMULATOR_TICK_SECONDS: '45' },
  },
  advance: {
    guida: {
      apri: ['App passeggero  http://localhost:5174', 'Dashboard operatore  http://localhost:5173'],
      guarda: [
        'Prenota una corsa per **fra due o tre minuti**: l’anticipo di attivazione qui è di un minuto',
        'invece di quindici, e il controllo gira ogni dieci secondi invece che ogni minuto.',
        'La prenotazione resta in elenco, separata dalla corsa live, finché non scatta l’attivazione.',
        'Quando manca un minuto all’orario il veicolo viene assegnato da solo e la corsa comincia:',
        'nessuno ha premuto niente, ed è il punto dello scenario.',
      ],
    },
    // Lo script Playwright di questo scenario non è ancora scritto: è il task successivo.
    scripted: false,
    title: 'Scenario 2 — prenotazione anticipata',
    grep: 'Scenario 2',
    dataset: 'seed',
    env: {
      SIMULATOR_TICK_SECONDS: '45',
      // L'anticipo di attivazione scende da quindici minuti a uno, e il controllo passa da ogni
      // minuto a ogni dieci secondi: senza entrambi, lo scenario si guarderebbe per un quarto d'ora.
      RESERVATION_ACTIVATION_LEAD_MINUTES: '1',
      ADVANCE_BOOKING_CRON: '*/10 * * * * *',
    },
  },
  traffic: {
    guida: {
      apri: ['Dashboard operatore  http://localhost:5173'],
      guarda: [
        'Guarda il pannello «Strategia di allocazione». La sequenza dura due minuti dall’avvio:',
        '  0s  LOW     — strategia «Più vicino disponibile»',
        '  20s MEDIUM  — compare un alert che **suggerisce** ETA minimo, e la strategia NON cambia',
        '  50s HIGH    — il sistema commuta da solo a «ETA minimo»',
        '  80s MEDIUM  — resta su ETA minimo: è l’isteresi, non si torna indietro a metà (NFR9)',
        ' 110s LOW     — solo ora rientra su «Più vicino disponibile»',
        'Poi premi «ETA minimo» a mano: il modo passa a Manual e ogni cambio automatico si ferma',
        '(R13). «Riabilita il modo Auto» rivaluta subito l’ultimo livello letto.',
      ],
    },
    // Lo script Playwright di questo scenario non è ancora scritto: è il task successivo.
    scripted: false,
    title: 'Scenario 3 — traffico, isteresi e rientro in Auto',
    grep: 'Scenario 3',
    dataset: 'seed',
    env: {
      TRAFFIC_SOURCE: 'scripted',
      TRAFFIC_SCRIPT: 'LOW:0,MEDIUM:20,HIGH:50,MEDIUM:80,LOW:110',
      // Il monitor legge ogni dieci secondi, quindi ogni gradino della tabella viene osservato.
      TRAFFIC_CRON: '*/10 * * * * *',
    },
  },
  rebalancing: {
    guida: {
      apri: ['Dashboard operatore  http://localhost:5173'],
      guarda: [
        'C’è una partita a San Siro adesso, e i veicoli sono altrove. Il ciclo gira ogni quindici',
        'secondi invece che ogni dieci minuti.',
        'Guarda la mappa: un veicolo inattivo per volta si mette in viaggio verso lo stadio, con il',
        'marker nel colore di «In riposizionamento», e il log operativo ne dà conto.',
        'Quando arriva torna «Disponibile» **nella zona raggiunta**, senza attendere il ciclo',
        'successivo — è la telemetria a chiudere il riposizionamento (decisione D74).',
      ],
    },
    // Lo script Playwright di questo scenario non è ancora scritto: è il task successivo.
    scripted: false,
    title: 'Scenario 4 — riposizionamento verso San Siro',
    grep: 'Scenario 4',
    // La serata con la partita: il seed costruisce la città, `db:demo` ci mette sopra l'evento.
    dataset: 'demo',
    env: {
      SIMULATOR_TICK_SECONDS: '45',
      REBALANCING_CRON: '*/15 * * * * *',
    },
  },
};

const PORTS = [3000, 5173, 5174];

/** Vero se qualcuno è già in ascolto su quella porta. */
function inUse(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(true));
    probe.once('listening', () => probe.close(() => resolve(false)));
    probe.listen(port, '127.0.0.1');
  });
}

/**
 * Rifiuta di partire se lo stack è già in piedi, invece di riusarlo.
 *
 * Sembra scortese ed è la correzione di una trappola che ci ha morso due volte. Playwright ha
 * `reuseExistingServer` attivo in locale, quindi un `pnpm dev` lasciato aperto viene **riusato**: e
 * Vite risolve `import.meta.env` all'avvio mentre Nest legge le variabili all'import, quindi quei
 * processi servono codice aggiornato e **ambiente vecchio**. Una demo così racconta lo scenario
 * sbagliato senza dare un solo segnale. Meglio fallire rumorosamente.
 */
async function refuseIfRunning() {
  const busy = [];
  for (const port of PORTS) if (await inUse(port)) busy.push(port);
  if (busy.length === 0) return;

  console.error(
    colors.bold(`\nPorte già occupate: ${busy.join(', ')}.\n`) +
      "Uno stack è già in esecuzione, e la demo lo riuserebbe con l'ambiente con cui è stato\n" +
      'avviato — non con quello di questo scenario. Chiudilo e riprova.\n\n' +
      'PowerShell:\n' +
      `  Get-NetTCPConnection -State Listen -LocalPort ${PORTS.join(',')} | ` +
      'Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force }\n',
  );
  process.exit(1);
}

const name = process.argv[2];
const scenario = SCENARIOS[name];

if (scenario === undefined) {
  console.error(
    `Scenario sconosciuto: ${name ?? '(nessuno)'}.\n` +
      `Disponibili: ${Object.keys(SCENARIOS).join(', ')}.`,
  );
  process.exit(1);
}

await refuseIfRunning();

console.log(colors.bold(`\n${scenario.title}\n`));

if (buildPackages() !== 0) process.exit(1);

/*
 * I dati di partenza, ricostruiti a ogni esecuzione.
 *
 * Una demo deve partire da uno stato noto: senza il seed, la dashboard mostrerebbe la strategia e il
 * modo lasciati lì dall'esecuzione precedente, e lo scenario racconterebbe una storia diversa da
 * quella che dice di raccontare.
 */
console.log(colors.dim('Preparazione del database…'));
runOrExit('docker', ['compose', 'up', '-d', 'postgres']);
runOrExit('node', ['tools/db/migrate.mjs']);
runOrExit('node', ['tools/db/seed.mjs']);
if (scenario.dataset === 'demo') runOrExit('node', ['tools/db/demo.mjs']);

/**
 * Due modi di dimostrare, e il secondo non è un ripiego povero.
 *
 * Se lo scenario ha uno script Playwright lo si esegue: rigioca la storia da solo e lascia gli
 * screenshot, che è ciò che serve **a noi** per accorgerci che una demo si è rotta prima di
 * scoprirlo davanti a chi guarda.
 *
 * Altrimenti si alza lo stack e si dice cosa aprire e cosa guardare, lasciandolo acceso. È ciò che
 * serve **a chi guarda**, ed è la forma giusta per gli scenari 3 e 4: lì non c'è niente da guidare —
 * il traffico cambia da solo, il riposizionamento parte da solo — e uno script sarebbe «aspetta e
 * asserisci», cioè un test travestito da dimostrazione.
 *
 * `--live` forza il secondo modo anche dove il primo esiste: `pnpm demo:immediate --live` prepara la
 * corsa immediata e lascia che sia una persona a richiederla.
 */
const live = process.argv.includes('--live');

if (scenario.scripted === true && !live) {
  console.log(colors.dim('Avvio dello stack e dello scenario…\n'));
  process.exit(
    run('npx', ['playwright', 'test', '--project=demo', '--grep', scenario.grep], {
      env: scenario.env,
    }),
  );
}

console.log(colors.bold('Da aprire nel browser:'));
for (const riga of scenario.guida.apri) console.log(`  ${riga}`);

console.log(colors.bold('\nChe cosa guardare:'));
for (const riga of scenario.guida.guarda) console.log(`  ${riga}`);

if (scenario.scripted !== true) {
  console.log(
    colors.dim(
      '\nQuesto scenario non ha ancora uno script Playwright: si guarda, non si rigioca da solo.',
    ),
  );
}

console.log(colors.bold('\nLo stack resta acceso. Ctrl-C per fermarlo.\n'));

// `pnpm dev` alza i tre servizi e resta in primo piano: l'interruzione arriva al figlio, che spegne
// i propri. Non c'è un secondo runner, ed è la stessa catena degli scenari end-to-end.
process.exit(run('pnpm', ['dev'], { env: scenario.env }));
