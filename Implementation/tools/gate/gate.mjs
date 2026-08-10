// `pnpm gate <M>` — esegue il cancello di una singola milestone (HARNESS.md §6).
//
// Regola: non si passa alla milestone successiva finché il cancello della precedente non è verde,
// e i cancelli già passati non tornano mai rossi (girano tutti dentro `pnpm verify`).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { run, repoRoot, colors } from '../lib/run.mjs';

const gatesDir = join(repoRoot, 'apps', 'api', 'test', 'gates');
const milestone = process.argv[2];

const available = existsSync(gatesDir)
  ? readdirSync(gatesDir)
      .filter((file) => file.endsWith('.gate.spec.ts'))
      .map((file) => file.replace('.gate.spec.ts', ''))
  : [];

if (!milestone) {
  console.error('Uso: pnpm gate <milestone>   (es. pnpm gate M0)');
  console.error(`Cancelli presenti: ${available.join(', ') || 'nessuno'}`);
  process.exit(1);
}

if (!available.includes(milestone)) {
  console.error(
    colors.red(`Nessun cancello per la milestone "${milestone}".`) +
      `\nAtteso il file apps/api/test/gates/${milestone}.gate.spec.ts.` +
      `\nCancelli presenti: ${available.join(', ') || 'nessuno'}`,
  );
  process.exit(1);
}

// `--testPathPatterns` e non il pattern posizionale: con Jest 30 e una configurazione a
// `projects`, l'argomento posizionale viene ignorato e `pnpm gate M0` eseguiva *tutti* i
// cancelli. Passava lo stesso, quindi il difetto era invisibile — un comando che dice di fare una
// cosa e ne fa un'altra è peggio di un comando che fallisce.
process.exit(
  run('npx', [
    'jest',
    '--selectProjects',
    'gate',
    '--testPathPatterns',
    `gates/${milestone}\\.gate\\.spec\\.ts$`,
  ]),
);
