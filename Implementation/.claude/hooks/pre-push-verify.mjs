// PreToolUse su Bash.
// Intercetta i `git push`: rifiuta se il branch è main e blocca se `pnpm verify` è rosso.
// Effetto: non è possibile spingere lavoro rotto, né scavalcare il flusso con pull request.

import { readPayload, projectNotReady, runPnpm, currentBranch, block, tail } from './_shared.mjs';

const payload = await readPayload();
const command = payload?.tool_input?.command ?? '';

if (!/\bgit\s+push\b/.test(command)) process.exit(0);

const branch = currentBranch();
if (branch === 'main' || branch === 'master') {
  block(
    `Push su "${branch}" bloccato.\n` +
      'Il lavoro va su un branch di milestone (es. feat/M3-allocation) e arriva in main tramite ' +
      'pull request approvata dal team. Crea il branch con `git switch -c feat/<milestone>-<slug>`.',
  );
}

if (projectNotReady()) process.exit(0);

process.stderr.write('Hook pre-push: eseguo pnpm verify...\n');
const { ok, output } = runPnpm(['verify']);

if (!ok) {
  block(
    'Push bloccato: `pnpm verify` fallisce.\n' +
      'Correggi gli errori qui sotto e riprova. Non disabilitare test per far passare la verifica.\n\n' +
      tail(output, 80),
  );
}

process.exit(0);
