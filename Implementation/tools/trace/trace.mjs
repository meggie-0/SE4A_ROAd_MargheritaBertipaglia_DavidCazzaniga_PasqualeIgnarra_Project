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

/** Cartelle in cui cercare i test. Tutto ciò che finisce in .spec.ts o .e2e.spec.ts conta. */
const testRoots = [
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

/** Toglie commenti di riga e di blocco, così i tag citati in un commento non contano come test. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** Estrae i tag `[R5]`, `[NFR7]`, `[G2]` da un titolo di describe. */
function tagsOf(title) {
  return [...title.matchAll(/\[([A-Za-z]+\d+)\]/g)].map((match) => match[1].toUpperCase());
}

/**
 * Attribuisce ogni caso di test (`it` / `test`) ai tag dei `describe` che lo contengono.
 *
 * Lo scanner è volutamente semplice: segue la profondità delle graffe e tiene una pila dei
 * describe aperti. Non è un parser TypeScript, ma la forma dei file di test è regolare e il
 * criterio di fallimento — "almeno un test" — non dipende dall'esattezza del conteggio.
 */
function scan(file, counters, unknownTags, knownIds, milestoneIds) {
  const source = stripComments(readFileSync(file, 'utf8'));
  const openStack = [];
  let depth = 0;

  const blockPattern = /\b(describe|it|test)\s*(?:\.\s*\w+\s*)?\(\s*(['"`])((?:\\.|(?!\2).)*)\2/g;
  const events = [];

  let match;
  while ((match = blockPattern.exec(source)) !== null) {
    events.push({ index: match.index, kind: match[1], title: match[3] });
  }

  let cursor = 0;
  for (const event of events) {
    for (let i = cursor; i < event.index; i += 1) {
      const char = source[i];
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        while (openStack.length > 0 && openStack[openStack.length - 1].depth > depth) {
          openStack.pop();
        }
      }
    }
    cursor = event.index;

    if (event.kind === 'describe') {
      const tags = tagsOf(event.title);
      for (const tag of tags) {
        // I cancelli si intitolano con la milestone, es. describe('[M0] Cancello: ...'):
        // è un tag legittimo, non un refuso.
        if (!knownIds.has(tag) && !milestoneIds.has(tag)) {
          unknownTags.set(tag, (unknownTags.get(tag) ?? 0) + 1);
        }
      }
      openStack.push({ depth, tags });
    } else {
      const active = new Set(openStack.flatMap((entry) => entry.tags));
      for (const tag of active) {
        const counter = counters.get(tag);
        if (counter) {
          counter.tests += 1;
          counter.files.add(relative(repoRoot, file).replace(/\\/g, '/'));
        }
      }
    }
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
