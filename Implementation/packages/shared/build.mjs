// Costruisce `@road/shared` nei due formati che i suoi consumatori sanno leggere.
//
// Perché due e non uno: il backend NestJS e Jest caricano CommonJS, Vite (cioè i due client nel
// browser) carica ES module. Con il solo CommonJS il browser fallisce a runtime con
// "does not provide an export named 'fetchHealth'" — non a compilazione, il che lo rende un
// errore che si scopre tardi. Con il solo ESM sarebbe l'API a non partire.
//
// I due `package.json` scritti dentro dist/ dicono a Node come interpretare i .js di ciascuna
// cartella: senza il marcatore, `dist/esm/index.js` verrebbe letto come CommonJS.

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));

const build = spawnSync('npx tsc -b tsconfig.cjs.json tsconfig.esm.json', {
  cwd: packageRoot,
  stdio: 'inherit',
  shell: true,
});

if (build.status !== 0) process.exit(build.status ?? 1);

for (const [folder, type] of [
  ['cjs', 'commonjs'],
  ['esm', 'module'],
]) {
  const target = join(packageRoot, 'dist', folder);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`, 'utf8');
}
