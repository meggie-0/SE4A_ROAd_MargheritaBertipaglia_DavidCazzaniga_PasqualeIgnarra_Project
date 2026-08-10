// Compila `packages/shared` e `apps/api` prima di eseguire un entry point del database.
//
// `pnpm db:migrate` e `pnpm db:seed` lanciano codice TypeScript che vive dentro il modulo
// `persistence`: per eseguirlo serve la build, e farla qui evita di chiedere all'utente un passo
// in più che dimenticherebbe (o di introdurre un runner TypeScript fra le dipendenze, che
// MILESTONES.md non elenca).

import { buildShared, runOrExit } from '../lib/run.mjs';

export function buildApi() {
  const shared = buildShared();
  if (shared !== 0) process.exit(shared);
  runOrExit('pnpm', ['--filter', '@road/api', 'build']);
}
