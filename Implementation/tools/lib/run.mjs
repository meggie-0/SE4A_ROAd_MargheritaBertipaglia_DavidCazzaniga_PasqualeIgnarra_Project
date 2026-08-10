// Piccolo strato comune agli script di tooling.
// Scritti in Node e non in shell perché devono girare identici su Windows, macOS e Linux:
// la regola d'oro di HARNESS.md §1 è che la CI esegua esattamente ciò che gira in locale.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Radice del monorepo (la cartella Implementation/), calcolata da questo file. */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Esegue un comando ereditando stdio. Ritorna il codice di uscita.
 * Su Windows i binari di pnpm sono file .cmd, quindi serve `shell: true`.
 */
export function run(command, args, options = {}) {
  // Riga di comando unica invece di (comando, argomenti): con `shell: true` Node depreca la
  // seconda forma (DEP0190), perché gli argomenti verrebbero concatenati senza escape.
  const line = [command, ...args.map(quote)].join(' ');

  const result = spawnSync(line, {
    cwd: options.cwd ?? repoRoot,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  if (result.error) {
    console.error(`Impossibile eseguire "${line}": ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

/** Mette fra virgolette gli argomenti che la shell spezzerebbe o interpreterebbe. */
function quote(argument) {
  return /^[\w@./:=-]+$/.test(argument) ? argument : `"${argument.replace(/"/g, '\\"')}"`;
}

/** Come `run`, ma interrompe il processo al primo errore. */
export function runOrExit(command, args, options = {}) {
  const status = run(command, args, options);
  if (status !== 0) process.exit(status);
}

/** Esegue jest su uno dei progetti definiti in jest.config.mjs. */
export function jest(project, extraArgs = [], options = {}) {
  return run('npx', ['jest', '--selectProjects', project, ...extraArgs], options);
}

/** Ricompila packages/shared nei due formati: i suoi artefatti servono a typecheck, Jest e Vite. */
export function buildShared() {
  return run('pnpm', ['--filter', '@road/shared', 'build']);
}

// Colori ANSI. La sequenza di escape si costruisce a runtime invece di incollare il byte 0x1b
// dentro il sorgente: un carattere di controllo invisibile nel diff è una trappola.
const ESC = String.fromCharCode(27);
const paint = (code) => (text) => `${ESC}[${code}m${text}${ESC}[0m`;

export const colors = {
  bold: paint(1),
  dim: paint(2),
  red: paint(31),
  green: paint(32),
  yellow: paint(33),
};
