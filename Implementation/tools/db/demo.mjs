// `pnpm db:demo` — arrangia la serata con la partita a San Siro (MILESTONES.md §M9).
//
// Si esegue **dopo** `pnpm db:seed`: il seed costruisce la città, questo comando ci mette sopra una
// sera con un evento attivo adesso e la flotta lontana dallo stadio, così il riposizionamento ha
// qualcosa da fare mentre qualcuno guarda.
//
// Come per migrazioni e seed, la logica vive dentro il modulo `persistence`
// (`apps/api/src/persistence/demo.ts`) e scrive passando dalla sua porta. Qui c'è solo il lancio.

import { join } from 'node:path';

import { runOrExit, repoRoot } from '../lib/run.mjs';

import { buildApi } from './build-api.mjs';

buildApi();
runOrExit('node', [join(repoRoot, 'apps', 'api', 'dist', 'persistence', 'demo.js')]);
