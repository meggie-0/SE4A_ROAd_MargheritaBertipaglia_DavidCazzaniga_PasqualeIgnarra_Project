// Utilità comuni agli hook di ROAd.
// Scritti in Node (non in bash) perché devono funzionare su Windows, macOS e Linux.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Legge il payload JSON che Claude Code passa all'hook su stdin. */
export async function readPayload() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** true se le dipendenze non sono ancora installate: in quel caso gli hook non devono bloccare. */
export function projectNotReady() {
  return !existsSync('node_modules') || !existsSync('package.json');
}

/** Esegue un comando pnpm e restituisce { ok, output }. */
export function runPnpm(args) {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return { ok: result.status === 0, output };
}

/** Nome del branch corrente, o null se non siamo in un repo git. */
export function currentBranch() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/** Blocca l'azione e rimanda il messaggio a Claude. */
export function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** Coda dell'output, per non riversare migliaia di righe nel contesto. */
export function tail(text, lines = 60) {
  return text.split('\n').slice(-lines).join('\n');
}
