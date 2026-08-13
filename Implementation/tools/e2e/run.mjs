// `pnpm verify:e2e` — stack completo guidato da Playwright (HARNESS.md §1).
//
// È separato da `pnpm verify` perché è lento: alza l'intero stack e guida un browser vero.
// Gira a fine milestone e in CI su `main`.
//
// Playwright avvia da solo i tre servizi (vedi `webServer` in playwright.config.ts); qui si
// prepara ciò che quei servizi si aspettano di trovare già pronto.

import { run, runOrExit, buildPackages, colors } from '../lib/run.mjs';

if (buildPackages() !== 0) process.exit(1);

/*
 * Il database, che da M8 serve davvero.
 *
 * Fino a M7 l'unico scenario end-to-end leggeva `GET /health`, che risponde senza toccare il
 * database — la connessione del modulo `persistence` è pigra — quindi Postgres non serviva. Gli
 * scenari di M8 sono un'altra cosa: un passeggero che richiede una corsa ha bisogno di veicoli in
 * flotta, e un operatore che entra ha bisogno di un account operatore. Entrambi vengono dal seed.
 *
 * Le tre righe sono le stesse del README, nell'ordine in cui il README le mette: se un giorno
 * divergessero, sarebbe il README a essere sbagliato.
 */
console.log(colors.bold('\nPreparazione del database per gli scenari end-to-end…'));
runOrExit('docker', ['compose', 'up', '-d', 'postgres']);
runOrExit('node', ['tools/db/migrate.mjs']);
runOrExit('node', ['tools/db/seed.mjs']);

console.log(
  colors.dim(
    'I browser di Playwright vanno installati una volta sola: `pnpm exec playwright install chromium`.',
  ),
);

process.exit(run('npx', ['playwright', 'test', '--pass-with-no-tests']));
