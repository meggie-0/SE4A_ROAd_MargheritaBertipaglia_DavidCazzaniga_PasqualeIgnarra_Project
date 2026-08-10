// `pnpm verify` — il controllo principale (HARNESS.md §1).
//
// I passi sono ordinati dal più veloce al più lento e la sequenza si ferma al primo fallimento:
// così l'errore che arriva è quello più vicino alla causa. La CI esegue esattamente questo
// comando, non una lista parallela: ogni divergenza fra locale e CI sarebbe un bug dell'harness.

import { run, buildShared, colors } from '../lib/run.mjs';

const steps = [
  {
    name: 'shared',
    what: 'compila packages/shared (i suoi tipi servono a tutto il resto)',
    execute: () => buildShared(),
  },
  {
    name: 'typecheck',
    what: 'tipi di api, web, passenger e shared, in strict mode',
    execute: () => run('node', ['tools/typecheck/typecheck.mjs']),
  },
  {
    name: 'lint',
    what: 'ESLint + regole di determinismo (CLAUDE.md Regola 3) + Prettier',
    execute: () => run('npx', ['eslint', '.']) || run('npx', ['prettier', '--check', '.']),
  },
  {
    name: 'arch',
    what: 'confini fra moduli (CLAUDE.md Regola 1)',
    execute: () => run('node', ['tools/arch/arch.mjs']),
  },
  {
    name: 'contract',
    what: 'OpenAPI rigenerato e confrontato con contracts/openapi.json',
    execute: () => run('npx', ['jest', '--selectProjects', 'contract']),
  },
  {
    name: 'unit',
    what: 'test unitari',
    execute: () => run('npx', ['jest', '--selectProjects', 'unit']),
  },
  {
    name: 'gate',
    what: 'cancelli di milestone già superati (HARNESS.md §6: non devono mai tornare rossi)',
    execute: () => run('npx', ['jest', '--selectProjects', 'gate']),
  },
  {
    name: 'integration',
    what: 'test di integrazione su Postgres reale',
    execute: () => run('npx', ['jest', '--selectProjects', 'integration', '--passWithNoTests']),
  },
];

const startedAt = Date.now();

for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  console.log(`\n${colors.bold(label)} ${colors.dim(`— ${step.what}`)}`);

  const stepStartedAt = Date.now();
  const status = step.execute();
  const seconds = ((Date.now() - stepStartedAt) / 1000).toFixed(1);

  if (status !== 0) {
    console.error(`\n${colors.red(`verify: fallito al passo "${step.name}" dopo ${seconds}s.`)}`);
    console.error(
      colors.dim(
        'Il lavoro non è finito finché questo comando non è verde. ' +
          'Non disabilitare test e non aggiungere .skip per farlo passare.',
      ),
    );
    process.exit(status);
  }

  console.log(colors.dim(`   ok in ${seconds}s`));
}

const total = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n${colors.green(`verify: tutto verde in ${total}s.`)}`);
