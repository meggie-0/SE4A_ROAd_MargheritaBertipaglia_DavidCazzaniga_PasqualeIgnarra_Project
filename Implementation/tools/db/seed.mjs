// `pnpm db:seed` — carica i dati di partenza (MILESTONES.md §M1): 16 zone di Milano, 20 robotaxi,
// una settimana di domanda di base, tre eventi di domanda.
//
// Come per le migrazioni, il seed vive dentro il modulo `persistence`
// (`apps/api/src/persistence/seed.ts`) e scrive passando dalla sua porta. Qui c'è solo il lancio.

import { join } from 'node:path';

import { runOrExit, repoRoot } from '../lib/run.mjs';

import { buildApi } from './build-api.mjs';

buildApi();
runOrExit('node', [join(repoRoot, 'apps', 'api', 'dist', 'persistence', 'seed.js')]);
