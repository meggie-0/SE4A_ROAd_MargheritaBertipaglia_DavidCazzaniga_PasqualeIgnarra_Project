// PostToolUse su Edit/Write/MultiEdit.
// Fa girare ESLint sul singolo file appena modificato: veloce, e coglie subito le violazioni
// delle regole di determinismo (CLAUDE.md Regola 3) invece di lasciarle accumulare.

import { spawnSync } from 'node:child_process';
import { readPayload, projectNotReady, block, tail } from './_shared.mjs';

const payload = await readPayload();
const filePath = payload?.tool_input?.file_path ?? '';

if (!/\.(ts|tsx|mts|cts)$/.test(filePath)) process.exit(0);
if (projectNotReady()) process.exit(0);

const result = spawnSync('npx', ['eslint', '--fix', filePath], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  block(
    `ESLint segnala problemi in ${filePath}. Correggili prima di proseguire.\n\n${tail(output, 40)}`,
  );
}

process.exit(0);
