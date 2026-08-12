// `pnpm verify:e2e` — stack completo guidato da Playwright (HARNESS.md §1).
//
// È separato da `pnpm verify` perché è lento: alza l'intero stack e guida un browser vero.
// Gira a fine milestone e in CI su `main`.
//
// Playwright avvia da solo i tre servizi (vedi `webServer` in playwright.config.ts); qui ci si
// limita a ricompilare `packages/shared`, perché è ciò che i client caricano.

import { run, buildPackages, colors } from '../lib/run.mjs';

if (buildPackages() !== 0) process.exit(1);

console.log(
  colors.dim(
    'I browser di Playwright vanno installati una volta sola: `pnpm exec playwright install chromium`.',
  ),
);

process.exit(run('npx', ['playwright', 'test', '--pass-with-no-tests']));
