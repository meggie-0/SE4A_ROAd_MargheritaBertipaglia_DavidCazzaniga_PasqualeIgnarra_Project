// Stop hook.
// Alla fine di ogni turno esegue `pnpm verify`. Se è rosso, la sessione non si chiude e l'errore
// torna indietro perché venga corretto. Impedisce il fallimento più comune: dichiarare finito
// qualcosa che non compila o che rompe i test.

import { readPayload, projectNotReady, runPnpm, block, tail } from './_shared.mjs';

const payload = await readPayload();

// Se siamo già dentro un blocco causato da questo stesso hook, non bloccare di nuovo:
// eviterebbe un ciclo infinito.
if (payload?.stop_hook_active) process.exit(0);
if (projectNotReady()) process.exit(0);

const { ok, output } = runPnpm(['verify']);

if (!ok) {
  block(
    'Non puoi chiudere il turno: `pnpm verify` fallisce.\n' +
      'Sistema quanto segue, poi riprova. Se il problema non è risolvibile, dillo esplicitamente ' +
      'invece di dichiarare completata la milestone.\n\n' +
      tail(output, 80),
  );
}

process.exit(0);
