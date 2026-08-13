// `pnpm trace` — tracciabilità eseguibile (HARNESS.md §5).
//
// Legge `docs/requirements.json` (34 voci: R1–R14, NFR1–NFR10, G1–G10), scansiona i titoli dei
// `describe` di tutta la suite e incrocia le due liste. Un requisito è coperto quando almeno un
// test dichiara il suo tag nel titolo, es. describe('[R5][NFR7] Automated Vehicle Allocation').
//
// Quando fallisce: se un requisito assegnato a una milestone già completata ha zero test.
// "Milestone completata" ha una definizione meccanica, non un elenco da tenere aggiornato a mano:
// è una milestone il cui cancello esiste (apps/api/test/gates/<M>.gate.spec.ts). Il cancello si
// scrive alla fine della milestone, quindi la milestone in corso comincia a essere pretesa dal
// tracciamento esattamente quando dichiari di averla chiusa.
//
// L'output è anche la base della tabella di tracciabilità del DD §4.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { repoRoot, colors } from '../lib/run.mjs';

const requirementsPath = join(repoRoot, 'docs', 'requirements.json');
const gatesDir = join(repoRoot, 'apps', 'api', 'test', 'gates');

/**
 * Cartelle in cui cercare i test. Tutto ciò che finisce in .spec.ts o .e2e.spec.ts conta.
 *
 * `ROAD_TRACE_ROOTS` le sostituisce: serve al cancello, che punta il tracciatore su un albero di
 * fixture per verificare che sappia contare davvero. Un tracciatore sbagliato è peggio di nessun
 * tracciatore — dichiara scoperto un requisito che ha i test, o coperto uno che non li ha.
 */
const testRoots = process.env.ROAD_TRACE_ROOTS
  ? process.env.ROAD_TRACE_ROOTS.split(';').filter((root) => root.length > 0)
  : [
      join(repoRoot, 'apps'),
      join(repoRoot, 'packages'),
      join(repoRoot, 'tools'),
      join(repoRoot, 'e2e'),
    ];

const IGNORED_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.tsbuild', '.git']);

function collectSpecFiles(root, found = []) {
  if (!existsSync(root)) return found;
  for (const entry of readdirSync(root)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) collectSpecFiles(full, found);
    else if (/\.spec\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/**
 * Le parole dopo le quali una barra apre un'espressione regolare e non è una divisione.
 *
 * Distinguere i due casi in JavaScript richiede il token precedente, e questa è la forma ridotta
 * che basta a dei file di test: dopo un identificatore, un numero o una parentesi chiusa la barra
 * divide; dopo un operatore, una parentesi aperta, una virgola o una di queste parole, apre.
 */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'case',
  'in',
  'of',
  'do',
  'else',
  'yield',
  'await',
  'new',
  'delete',
  'void',
]);

/** Vero se la barra in `index` apre un'espressione regolare invece di dividere. */
function opensRegex(source, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return true;

  const previous = source[i];
  // Dopo un identificatore, una cifra, `)` o `]` una barra è una divisione — tranne che dopo una
  // delle parole chiave qui sopra, che identificatori non sono.
  if (/[\w$]/.test(previous)) {
    let start = i;
    while (start >= 0 && /[\w$]/.test(source[start])) start -= 1;
    return REGEX_KEYWORDS.has(source.slice(start + 1, i + 1));
  }
  return previous !== ')' && previous !== ']';
}

/** L'indice della barra che chiude l'espressione regolare aperta in `start`. */
function endOfRegex(source, start) {
  let inClass = false;

  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    // Dentro una classe `[...]` la barra non chiude niente: `/[/]/` è un'espressione valida.
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) return i;
    // Un'espressione regolare non attraversa una riga a capo: se la incontra, non lo era.
    else if (char === '\n') return start;
  }
  return start;
}

/**
 * Normalizza il sorgente per la scansione: via i commenti, neutro il contenuto delle espressioni
 * regolari, intatte le stringhe.
 *
 * Le stringhe restano intere perché è da lì che si legge il titolo di un `describe`. Tutto il
 * resto è stato imparato a spese di due difetti veri, entrambi della stessa famiglia — un pezzo di
 * sorgente che *sembra* un'altra cosa:
 *
 *  - la versione a due espressioni regolari trattava una barra seguita da un asterisco **dentro
 *    una stringa** come l'apertura di un commento, e cancellava fino alla chiusura successiva:
 *    spariva il blocco di documentazione che veniva dopo e, con lui, il `describe` che apriva. Il
 *    caso reale è il glob di Playwright di `e2e/passenger-ride.e2e.spec.ts`, che faceva risultare
 *    NFR6 **scoperto** pur avendo il suo test;
 *  - saltare le sole stringhe non bastava, perché un apice **dentro un'espressione regolare** —
 *    `toMatch(/fetch['"]x/)`, che sta nel cancello di M8 — veniva preso per l'inizio di una
 *    stringa, e la ricerca dell'apice di chiusura si mangiava tutto fino a quello successivo nel
 *    file. Lì l'effetto era il peggiore dei due: non un requisito scoperto ma un requisito
 *    **attribuito male**, con NFR8 contato 11 volte invece di 3 perché il suo `describe` non
 *    veniva più chiuso.
 *
 * Il corpo dell'espressione regolare si azzera invece di essere copiato: dentro non c'è solo il
 * rischio degli apici, ci sono anche le graffe dei quantificatori — `\d{2}` — che falserebbero la
 * profondità con cui `scan` decide quando un `describe` finisce.
 *
 * È esattamente il difetto contro cui mette in guardia HARNESS.md §5 — «un tracciatore che conta
 * male è peggio di nessun tracciatore, perché dichiara scoperto un requisito che ha i test e porta
 * a inseguire un difetto che non esiste».
 */
function stripComments(source) {
  let out = '';

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    // Una stringa si copia per intero: quello che c'è dentro non è codice, e non è un commento.
    if (`'"\``.includes(char)) {
      const end = endOfLiteral(source, i);
      out += source.slice(i, end + 1);
      i = end;
      continue;
    }

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      continue;
    }

    if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      // La riga a capo si conserva: le espressioni regolari a valle ragionano per riga.
      i = end === -1 ? source.length : end - 1;
      continue;
    }

    if (char === '/' && opensRegex(source, i)) {
      const end = endOfRegex(source, i);
      if (end > i) {
        // Delimitatori sì, corpo no: a `scan` serve sapere che lì c'era qualcosa, non cosa.
        out += '/x/';
        i = end;
        continue;
      }
    }

    out += char;
  }

  return out;
}

/** Estrae i tag `[R5]`, `[NFR7]`, `[G2]` da un titolo di describe. */
function tagsOf(title) {
  return [...title.matchAll(/\[([A-Za-z]+\d+)\]/g)].map((match) => match[1].toUpperCase());
}

/** Fine di una stringa o di un template literal che inizia in `start`. Ritorna l'indice del delimitatore di chiusura. */
function endOfLiteral(source, start) {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === quote) return i;
    // Dentro un template, `${...}` può contenere di tutto, comprese altre stringhe.
    if (quote === '`' && char === '$' && source[i + 1] === '{') {
      let nesting = 1;
      i += 2;
      while (i < source.length && nesting > 0) {
        if (source[i] === '\\') i += 1;
        else if (`'"\``.includes(source[i])) i = endOfLiteral(source, i);
        else if (source[i] === '{') nesting += 1;
        else if (source[i] === '}') nesting -= 1;
        i += 1;
      }
      i -= 1;
    }
  }
  return source.length;
}

/**
 * Riconosce l'apertura di un blocco Jest a partire dalla parola chiave in `start`.
 *
 * Deve reggere tutte le forme che il progetto usa davvero, non solo la più semplice:
 * `it('t')`, `it.only('t')`, `it.each([...])('t')` e `it.each\`tabella\`('t')`. La versione
 * precedente pretendeva l'apice subito dopo la parentesi e quindi *non vedeva* i test scritti
 * con `it.each` — che nel cancello M0 sono quattro su cinque. Un requisito coperto da soli
 * `it.each` sarebbe risultato scoperto, e `pnpm trace` avrebbe accusato codice sano.
 *
 * Ritorna `{ title }` se il blocco è riconosciuto, altrimenti `null`.
 */
function parseBlockOpening(source, start) {
  let i = start;
  const skipSpace = () => {
    while (i < source.length && /\s/.test(source[i])) i += 1;
  };

  skipSpace();

  // Modificatori concatenati: .only, .skip, .concurrent, .failing, .each(...), .each`...`
  while (source[i] === '.') {
    i += 1;
    skipSpace();
    const modifier = /^\w+/.exec(source.slice(i));
    if (!modifier) return null;
    i += modifier[0].length;
    skipSpace();

    // `.each` porta con sé la tabella dei casi, che va saltata per intero.
    if (source[i] === '(' || source[i] === '`') {
      if (source[i] === '`') {
        i = endOfLiteral(source, i) + 1;
      } else {
        let nesting = 0;
        while (i < source.length) {
          const char = source[i];
          if (`'"\``.includes(char)) i = endOfLiteral(source, i);
          else if (char === '(') nesting += 1;
          else if (char === ')') {
            nesting -= 1;
            if (nesting === 0) {
              i += 1;
              break;
            }
          }
          i += 1;
        }
      }
      skipSpace();
    }
  }

  if (source[i] !== '(') return null;
  i += 1;
  skipSpace();

  if (!`'"\``.includes(source[i])) return null;
  const titleEnd = endOfLiteral(source, i);
  return { title: source.slice(i + 1, titleEnd) };
}

/**
 * Attribuisce ogni caso di test (`it` / `test`) ai tag dei `describe` che lo contengono.
 *
 * Lo scanner segue la profondità delle graffe e tiene una pila dei describe aperti. Non è un
 * parser TypeScript, ma salta il contenuto di stringhe e template — dove una graffa spaiata
 * falserebbe il conteggio — e la forma dei file di test è regolare.
 */
const BLOCK_KEYWORDS = ['describe', 'it', 'test'];

function scan(file, counters, unknownTags, knownIds, milestoneIds) {
  const source = stripComments(readFileSync(file, 'utf8'));
  const openStack = [];
  let depth = 0;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    // Il contenuto di stringhe e template si salta per intero: una graffa dentro una stringa
    // falserebbe la profondità, e un `describe(...)` citato dentro un test — per esempio nel test
    // di questo stesso tracciatore — verrebbe contato come se fosse vero.
    if (`'"\``.includes(char)) {
      i = endOfLiteral(source, i);
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      // `>` e non `>=`: il corpo di un describe vive a profondità depth+1, quindi quando la
      // graffa si richiude e si torna a depth il describe dev'essere già stato tolto. Con la
      // condizione sbagliata un describe di primo livello non usciva mai dalla pila e i suoi
      // tag finivano addosso ai test dei describe successivi.
      while (openStack.length > 0 && openStack[openStack.length - 1].depth > depth) {
        openStack.pop();
      }
      continue;
    }

    const previous = i > 0 ? source[i - 1] : ' ';
    if (/[\w$]/.test(previous)) continue;

    const keyword = BLOCK_KEYWORDS.find((candidate) => source.startsWith(candidate, i));
    if (!keyword || /[\w$]/.test(source[i + keyword.length] ?? ' ')) continue;

    const block = parseBlockOpening(source, i + keyword.length);
    if (!block) continue;

    if (keyword === 'describe') {
      const tags = tagsOf(block.title);
      for (const tag of tags) {
        // I cancelli si intitolano con la milestone, es. describe('[M0] Cancello: ...'):
        // è un tag legittimo, non un refuso.
        if (!knownIds.has(tag) && !milestoneIds.has(tag)) {
          unknownTags.set(tag, (unknownTags.get(tag) ?? 0) + 1);
        }
      }
      openStack.push({ depth: depth + 1, tags });
    } else {
      for (const tag of new Set(openStack.flatMap((entry) => entry.tags))) {
        const counter = counters.get(tag);
        if (counter) {
          counter.tests += 1;
          counter.files.add(relative(repoRoot, file).replace(/\\/g, '/'));
        }
      }
    }

    i += keyword.length - 1;
  }
}

function main() {
  if (!existsSync(requirementsPath)) {
    console.error(colors.red(`Manca ${relative(repoRoot, requirementsPath)}.`));
    process.exit(1);
  }

  const requirements = JSON.parse(readFileSync(requirementsPath, 'utf8'));
  const entries = [
    ...requirements.functional,
    ...requirements.nonFunctional,
    ...requirements.goals,
  ];

  const counters = new Map(entries.map((entry) => [entry.id, { tests: 0, files: new Set() }]));
  const knownIds = new Set(entries.map((entry) => entry.id));
  const unknownTags = new Map();

  const milestoneIds = new Set(
    (requirements.milestoneOrder ?? []).map((milestone) => milestone.toUpperCase()),
  );

  const specFiles = testRoots.flatMap((root) => collectSpecFiles(root));
  for (const file of specFiles) scan(file, counters, unknownTags, knownIds, milestoneIds);

  const completedMilestones = existsSync(gatesDir)
    ? new Set(
        readdirSync(gatesDir)
          .filter((file) => file.endsWith('.gate.spec.ts'))
          .map((file) => file.replace('.gate.spec.ts', '')),
      )
    : new Set();

  const expected = entries.filter((entry) => completedMilestones.has(entry.milestone));
  const covered = expected.filter((entry) => (counters.get(entry.id)?.tests ?? 0) > 0);
  const missing = expected.filter((entry) => (counters.get(entry.id)?.tests ?? 0) === 0);

  const widths = {
    id: Math.max(9, ...entries.map((entry) => entry.id.length)),
    title: Math.max(6, ...entries.map((entry) => entry.title.length)),
    milestone: 9,
  };
  const pad = (text, width) => String(text).padEnd(width);

  console.log(
    colors.bold(
      `${pad('REQUISITO', widths.id)}  ${pad('TITOLO', widths.title)}  ` +
        `${pad('MILESTONE', widths.milestone)}  TEST`,
    ),
  );

  for (const entry of entries) {
    const tests = counters.get(entry.id)?.tests ?? 0;
    const isExpected = completedMilestones.has(entry.milestone);
    const line =
      `${pad(entry.id, widths.id)}  ${pad(entry.title, widths.title)}  ` +
      `${pad(entry.milestone, widths.milestone)}  ${tests}`;

    if (tests > 0) console.log(line);
    else if (isExpected) console.log(colors.red(`${line}  ← scoperto`));
    else console.log(colors.dim(`${line}  (attesa in ${entry.milestone})`));
  }

  console.log('');
  console.log(
    `Milestone con cancello scritto: ${[...completedMilestones].sort().join(', ') || 'nessuna'}`,
  );
  console.log(`File di test analizzati: ${specFiles.length}`);

  if (unknownTags.size > 0) {
    console.log('');
    console.log(
      colors.yellow(
        `Tag presenti nei test ma non in docs/requirements.json: ${[...unknownTags.keys()].join(', ')}`,
      ),
    );
    console.log(colors.dim('Di solito è un refuso nel titolo di un describe.'));
  }

  const summary = `Copertura milestone completate: ${covered.length}/${expected.length}`;
  if (missing.length > 0) {
    console.log('');
    console.log(colors.red(`${summary} ✗`));
    for (const entry of missing) {
      console.log(
        colors.red(
          `  ${entry.id} (${entry.milestone}) "${entry.title}" non ha nemmeno un test che lo nomini.`,
        ),
      );
    }
    console.log(
      colors.dim(
        "Aggiungi il tag nel titolo di un describe che lo copre davvero, es. describe('[R5] ...').",
      ),
    );
    process.exit(1);
  }

  console.log('');
  console.log(colors.green(`${summary} ✓`));
}

main();
