// `pnpm arch` — confini fra moduli (CLAUDE.md Regola 1, HARNESS.md §3).
//
// Due controlli complementari:
//  1. dependency-cruiser sugli import: nessun modulo raggiunto se non dalle sue porte;
//  2. un test che legge gli array `exports` dei @Module e pretende che contengano solo `*Port`.
// Il primo verifica come i file si importano, il secondo cosa Nest rende iniettabile fuori dal
// modulo: sono cose diverse e servono entrambe.

import { run, colors } from '../lib/run.mjs';

const depcruise = run('npx', [
  'depcruise',
  '--config',
  '.dependency-cruiser.cjs',
  '--output-type',
  'err',
  'apps',
  'packages',
  // Il simulatore di flotta (M7) vive in tools/ ma è codice del prodotto: la regola che lo tiene
  // dietro la porta non avrebbe niente da esaminare se il grafo si fermasse ad apps/ e packages/.
  'tools/simulator/src',
]);

if (depcruise !== 0) {
  console.error(colors.red('arch: dependency-cruiser ha trovato attraversamenti di confine.'));
  process.exit(depcruise);
}

const exportsTest = run('npx', ['jest', '--selectProjects', 'arch']);
if (exportsTest !== 0) {
  console.error(colors.red('arch: un @Module esporta qualcosa che non è una porta.'));
  process.exit(exportsTest);
}
