// `pnpm contract:update` — rigenera contracts/openapi.json.
//
// `pnpm contract` (che gira dentro `pnpm verify`) si limita a confrontare: se l'API è cambiata,
// fallisce. Questo comando è l'unico modo previsto per aggiornare il file, e il suo risultato va
// committato insieme al codice che ha cambiato l'API, così la modifica compare nel diff della
// pull request (HARNESS.md §4).

import { run, buildShared, colors } from '../lib/run.mjs';

if (buildShared() !== 0) process.exit(1);

const status = run('npx', ['jest', '--selectProjects', 'contract'], {
  env: { ROAD_UPDATE_OPENAPI: '1' },
});

if (status !== 0) process.exit(status);

console.log(
  colors.green('contracts/openapi.json aggiornato.') +
    ' Ricordati di committarlo insieme al codice che ha cambiato il contratto.',
);
