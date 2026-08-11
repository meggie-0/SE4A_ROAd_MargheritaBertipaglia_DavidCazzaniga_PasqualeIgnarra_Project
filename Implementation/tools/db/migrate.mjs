// `pnpm db:migrate` — applica le migrazioni TypeORM (MILESTONES.md §M1).
//
// Il lavoro vero sta in `apps/api/src/persistence/migrate.ts`: migrazioni e schema sono affari
// del modulo `persistence`, e un file qui fuori che li raggiungesse dovrebbe importarne gli
// interni, cioè attraversare un confine (CLAUDE.md Regola 1). Questo script compila e lancia
// quell'entry point.

import { join } from 'node:path';

import { runOrExit, repoRoot } from '../lib/run.mjs';

import { buildApi } from './build-api.mjs';

buildApi();
runOrExit('node', [join(repoRoot, 'apps', 'api', 'dist', 'persistence', 'migrate.js')]);
