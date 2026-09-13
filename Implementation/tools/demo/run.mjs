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

import { spawn } from 'node:child_process';
import { connect } from 'node:net';

import { run, runOrExit, buildPackages, colors, repoRoot } from '../lib/run.mjs';

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
    durata: 'circa due minuti, a seconda del percorso scelto.',
    guida: {
      apri: [
        'App passeggero      http://localhost:5174',
        'Dashboard operatore http://localhost:5173',
      ],
      guarda: [
        '1. Nell’app passeggero, accedi e seleziona sulla mappa il punto di partenza e la destinazione.',
        '2. Richiedi la corsa e osserva il passaggio attraverso le diverse fasi del viaggio.',
        '3. Nella dashboard operatore, individua il taxi assegnato e seguilo mentre raggiunge il passeggero.',
        '4. Osserva il cambio di stato del veicolo e gli aggiornamenti in tempo reale nel log operativo.',
      ],
    },
    scripted: true,
    title: 'Scenario 1 - corsa immediata',
    grep: 'Scenario 1',
    dataset: 'seed',
    env: { SIMULATOR_TICK_SECONDS: '45' },
  },
  advance: {
    durata:
      'circa tre o quattro minuti. Per velocizzare la demo, prenota una corsa con partenza fra due o tre minuti.',
    guida: {
      apri: [
        'App passeggero      http://localhost:5174',
        'Dashboard operatore http://localhost:5173',
      ],
      guarda: [
        '1. Nell’app passeggero, prenota una corsa con partenza fra due o tre minuti.',
        '2. La prenotazione compare inizialmente tra le corse programmate, senza un taxi ancora in viaggio.',
        '3. Un minuto prima dell’orario previsto, il sistema attiva automaticamente la corsa.',
        '4. Osserva l’assegnazione del taxi e l’inizio della corsa sia nell’app passeggero sia nella dashboard operatore.',
      ],
    },
    scripted: false,
    title: 'Scenario 2 - prenotazione anticipata',
    grep: 'Scenario 2',
    dataset: 'seed',
    env: {
      SIMULATOR_TICK_SECONDS: '15',
      RESERVATION_ACTIVATION_LEAD_MINUTES: '1',
      ADVANCE_BOOKING_CRON: '*/10 * * * * *',
    },
  },
  traffic: {
    durata: 'circa tre minuti. Lo scenario evolve automaticamente e non richiede interazione.',
    guida: {
      apri: ['Dashboard operatore http://localhost:5173'],
      guarda: [
        'Osserva contemporaneamente la mappa, la strategia di allocazione e il log operativo.',
        '',
        '  0 s   LOW     Il sistema usa la strategia «Più vicino disponibile».',
        ' 60 s   MEDIUM  Il traffico aumenta nelle zone centrali e viene mostrato un suggerimento.',
        ' 90 s   HIGH    Il sistema passa automaticamente alla strategia «ETA minimo».',
        '                Alcuni taxi più lontani possono risultare più convenienti grazie alle condizioni di traffico.',
        '150 s   MEDIUM  La strategia «ETA minimo» viene mantenuta per evitare cambi troppo frequenti.',
        '180 s   LOW     Il sistema torna automaticamente a «Più vicino disponibile».',
        '',
        'Durante lo scenario vengono generate automaticamente nuove richieste di corsa.',
        'Nel log operativo puoi vedere quale strategia ha determinato ogni assegnazione.',
      ],
    },
    scripted: false,
    requests: true,
    title: 'Scenario 3 - traffico e allocazione dinamica',
    grep: 'Scenario 3',
    dataset: 'seed',
    env: {
      TRAFFIC_SOURCE: 'scripted',
      TRAFFIC_SCRIPT: 'LOW:0,MEDIUM:60,HIGH:90,MEDIUM:150,LOW:180',
      TRAFFIC_CRON: '*/10 * * * * *',
      TRAFFIC_CENTRE_ZONES: 'duomo,cadorna,porta-venezia,navigli,porta-romana',
      TRAFFIC_TIME_FACTORS: 'MEDIUM:1.6,HIGH:4',
      ALLOCATION_EXPLANATIONS: 'on',
      SIMULATOR_TICK_SECONDS: '15',
    },
  },
  rebalancing: {
    durata: 'circa due minuti. Lo scenario evolve automaticamente e non richiede interazione.',
    guida: {
      apri: ['Dashboard operatore http://localhost:5173'],
      guarda: [
        'È in corso un evento a San Siro e la domanda prevista nella zona è aumentata.',
        '',
        '1. Osserva la distribuzione iniziale della flotta sulla mappa.',
        '2. A intervalli regolari, il sistema seleziona automaticamente taxi disponibili da altre zone.',
        '3. I taxi selezionati passano allo stato «In riposizionamento» e si dirigono verso San Siro.',
        '4. Il log operativo mostra ogni decisione di rebalancing.',
        '5. Quando un taxi raggiunge la zona di destinazione torna automaticamente «Disponibile».',
      ],
    },
    scripted: false,
    title: 'Scenario 4 — rebalancing verso San Siro',
    grep: 'Scenario 4',
    dataset: 'demo',
    env: {
      SIMULATOR_TICK_SECONDS: '15',
      REBALANCING_CRON: '*/15 * * * * *',
    },
  },
};

const PORTS = [3000, 5173, 5174];

/**
 * Vero se qualcuno risponde su quella porta, da una delle due interfacce di loopback.
 *
 * **Si prova a connettersi, non a occupare la porta**, e non è una preferenza. Fino al 1° settembre
 * la sonda faceva `listen(port, '127.0.0.1')` e deduceva «occupata» da un errore: su Windows quel
 * `bind` riesce anche quando la porta è presa, purché lo sia su un indirizzo diverso. Misurato,
 * server per server: non vedeva uno legato a `[::1]` — cioè Vite, che su Windows ascolta lì perché
 * `localhost` risolve prima in IPv6 —, né uno legato a `0.0.0.0` o a `::`, cioè Nest. Intercettava
 * soltanto un server legato esattamente a `127.0.0.1`, che nello stack non c'è. Il guard qui sotto
 * non ha mai protetto niente, e il `db:seed` che segue passava su un database che un altro stack
 * stava usando.
 *
 * La connessione invece risponde alla domanda che conta davvero — *c'è qualcuno dove la demo andrà
 * a cercare?* — e le due interfacce si provano entrambe perché nessuna delle due, da sola, copre
 * tutti i casi.
 */
function inUse(port) {
  const answers = (host) =>
    new Promise((resolve) => {
      const socket = connect({ port, host });
      const settle = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.setTimeout(500, () => settle(false));
      socket.once('connect', () => settle(true));
      socket.once('error', () => settle(false));
    });

  return answers('127.0.0.1').then((ipv4) => ipv4 || answers('::1'));
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
 * serve **a chi guarda**, ed è la forma giusta per gli scenari 3 e 4: lì chi guarda non ha niente da
 * premere — il traffico cambia da solo e le richieste le fa il generatore della D79, il
 * riposizionamento parte da solo — e uno script sarebbe «aspetta e asserisci», cioè un test
 * travestito da dimostrazione.
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

/**
 * Lo stack parte **prima** che si dica cosa aprire, e la differenza non è cosmetica.
 *
 * I due server Vite rispondono in un paio di secondi, l'API ci mette molto di più: `nest start`
 * compila in watch mode. Stampando le istruzioni subito, chi le segue apre la dashboard mentre
 * l'API non c'è ancora e legge «Impossibile contattare l'API» — poi aspetta, ricarica, e nel
 * frattempo lo scenario è cominciato senza di lui. Su San Siro, che si esaurisce in un minuto e
 * mezzo, questo significa aprire la pagina e non vedere **niente**.
 *
 * Quindi: si avvia, si aspetta che `GET /health` risponda, e solo allora si parla.
 */
const dev = spawn('pnpm dev', {
  cwd: repoRoot,
  shell: true,
  stdio: 'inherit',
  env: { ...process.env, ...scenario.env },
});

dev.on('exit', (code) => process.exit(code ?? 0));

/** Aspetta che l'API risponda, o si arrende dopo tre minuti dicendo perché. */
async function waitForApi() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch('http://localhost:3000/health');
      if (probe.ok) return true;
    } catch {
      // Non è ancora in ascolto: è lo stato normale dei primi secondi.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

console.log(colors.dim('\nAvvio dello stack… (l’API compila, può volerci un minuto)\n'));

if (!(await waitForApi())) {
  console.error(
    "L'API non ha risposto entro tre minuti. Lo stack resta acceso: guarda i log qui sopra.",
  );
} else {
  console.log(colors.bold('\n' + '─'.repeat(78)));
  console.log(colors.bold('Demo pronta.'));
  console.log(colors.bold('\nApri:'));
  for (const riga of scenario.guida.apri) console.log(`  ${riga}`);

  console.log(colors.bold('\nStep della demo:'));
  for (const riga of scenario.guida.guarda) console.log(`  ${riga}`);

  if (scenario.durata !== undefined) {
    console.log(colors.bold(`\nQuanto dura: ${scenario.durata}`));
  }

  console.log(colors.bold('\nLa demo è in esecuzione. Premi Ctrl+C per terminarla.'));
  console.log(colors.bold('─'.repeat(78) + '\n'));

  /**
   * Le richieste partono **dopo** che si è detto cosa aprire, e subito.
   *
   * La tabella del traffico conta dall'avvio dell'API, quindi il generatore non può aspettare chi
   * guarda: i primi quaranta secondi sono volutamente tranquilli, ed è il tempo di aprire la pagina.
   */
  if (scenario.requests === true) {
    console.log(colors.dim('Generazione automatica delle richieste di corsa:'));
    // Import dinamico, e non in testa al file: il generatore legge la build di `packages/shared`,
    // che su un clone pulito esiste solo dopo `buildPackages()` qui sopra.
    const { runRideRequests } = await import('./ride-requests.mjs');
    const outcomes = await runRideRequests({ log: (line) => console.log(colors.dim(line)) });
    const assigned = outcomes.filter((outcome) => outcome.robotaxiId !== null).length;
    console.log(
      colors.bold(
        `\n${outcomes.length} richieste, ${assigned} assegnate. Le corse finiscono da sole; Ctrl-C per chiudere.`,
      ),
    );
  }
}
