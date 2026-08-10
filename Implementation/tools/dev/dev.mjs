// `pnpm dev` — avvia API, dashboard operatore e app passeggero insieme.
//
// Scritto a mano invece di aggiungere un runner di processi: MILESTONES.md elenca le librerie
// ammesse e non ne contiene uno, e sessanta righe di Node fanno lo stesso lavoro.

import { spawn } from 'node:child_process';

import { repoRoot, buildShared, colors } from '../lib/run.mjs';

if (buildShared() !== 0) {
  console.error(colors.red('dev: packages/shared non compila, non ha senso avviare il resto.'));
  process.exit(1);
}

const services = [
  { name: 'api', color: colors.green, args: ['--filter', '@road/api', 'dev'] },
  { name: 'web', color: colors.yellow, args: ['--filter', '@road/web', 'dev'] },
  { name: 'passenger', color: colors.red, args: ['--filter', '@road/passenger', 'dev'] },
];

const children = [];
let shuttingDown = false;

function prefixed(service, chunk) {
  const label = service.color(`[${service.name}]`);
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim().length > 0) console.log(`${label} ${line}`);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exit(code);
}

for (const service of services) {
  const child = spawn('pnpm', service.args, { cwd: repoRoot, shell: true });
  child.stdout.on('data', (chunk) => prefixed(service, chunk));
  child.stderr.on('data', (chunk) => prefixed(service, chunk));
  child.on('exit', (code) => {
    console.log(service.color(`[${service.name}] terminato con codice ${code}`));
    shutdown(code ?? 1);
  });
  children.push(child);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log(colors.bold('\nROAd in sviluppo:'));
console.log('  API                 http://localhost:3000  (contratto su /docs)');
console.log('  Dashboard operatore http://localhost:5173');
console.log('  App passeggero      http://localhost:5174');
console.log(colors.dim('Ctrl+C per fermare tutto.\n'));
