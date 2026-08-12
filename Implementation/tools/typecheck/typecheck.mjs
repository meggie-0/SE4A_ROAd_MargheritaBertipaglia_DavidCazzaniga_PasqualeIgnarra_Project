// `pnpm typecheck` — passo 1 di `pnpm verify`.
//
// I pacchetti di libreria vanno compilati per primi: gli altri workspace ne consumano i .d.ts.
// Le applicazioni si controllano con --noEmit, perché il loro artefatto lo producono
// `nest build` e `vite build`.

import { run, buildPackages, colors } from '../lib/run.mjs';

if (buildPackages() !== 0) {
  console.error(colors.red('typecheck: la compilazione di packages/shared è fallita.'));
  process.exit(1);
}

const projects = [
  // Copre sia src/ sia test/ dell'API: i test sono codice come il resto.
  'apps/api/tsconfig.spec.json',
  'packages/shared/tsconfig.spec.json',
  // Il simulatore di flotta (M7): vive in tools/ ma è codice come gli altri, e chi lo compila lo
  // fa con lo stesso strict mode.
  'tools/simulator/tsconfig.json',
  'apps/web/tsconfig.json',
  'apps/passenger/tsconfig.json',
  'e2e/tsconfig.json',
];

for (const project of projects) {
  const status = run('npx', ['tsc', '--noEmit', '-p', project]);
  if (status !== 0) {
    console.error(colors.red(`typecheck: errori di tipo in ${project}.`));
    process.exit(status);
  }
}
