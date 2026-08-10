// Configurazione ESLint condivisa da tutti i workspace.
//
// Due responsabilità:
//  1. le regole TypeScript di base (fra cui il divieto di `any`, CLAUDE.md "Cose da non fare");
//  2. le regole di determinismo di CLAUDE.md Regola 3, che vietano nel codice di dominio ogni
//     accesso diretto all'orologio di sistema, alla casualità e ai timer.
//
// Il determinismo non è una preferenza stilistica: prenotazioni anticipate, isteresi del
// ModeController e rebalancing sono definiti sul tempo, e senza controllo del tempo i loro test
// diventano instabili (HARNESS.md §2).

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const determinismMessage = (what, port) =>
  `${what} è vietato nel codice di dominio (CLAUDE.md Regola 3): usa ${port}. ` +
  `Le uniche implementazioni ammesse stanno in apps/api/src/platform/.`;

/** Orologio di sistema e casualità: vietati ovunque tranne che dentro `platform`. */
const clockAndRandomSelectors = [
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: determinismMessage('new Date()', 'ClockPort.now()'),
  },
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: determinismMessage('Date.now()', 'ClockPort.now()'),
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: determinismMessage('Math.random()', 'RandomPort.next()'),
  },
];

/**
 * Timer.
 *
 * I selettori coprono anche `globalThis.setTimeout(...)`, perché la sola forma diretta si aggira
 * senza volerlo. Gli import dei moduli `timers` sono bloccati a parte: `import { setTimeout as
 * delay } from 'node:timers/promises'` è indistinguibile da qualunque altra chiamata a funzione
 * una volta rinominato, e nessun selettore sintattico può riconoscerlo.
 */
const timerSelectors = [
  {
    selector: 'CallExpression[callee.name=/^set(Timeout|Interval|Immediate)$/]',
    message: determinismMessage('setTimeout/setInterval', 'un metodo pubblico runOnce()'),
  },
  {
    selector: 'MemberExpression[property.name=/^set(Timeout|Interval|Immediate)$/]',
    message: determinismMessage('setTimeout/setInterval', 'un metodo pubblico runOnce()'),
  },
];

const timerImports = {
  'no-restricted-imports': [
    'error',
    {
      paths: ['timers', 'node:timers', 'timers/promises', 'node:timers/promises'].map((name) => ({
        name,
        message: determinismMessage('importare i timer di Node', 'un metodo pubblico runOnce()'),
      })),
    },
  ],
};

/** Regole di determinismo, applicate a tutto il codice sorgente tranne il modulo platform. */
const determinism = {
  'no-restricted-syntax': ['error', ...clockAndRandomSelectors, ...timerSelectors],
  ...timerImports,
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.tsbuild/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Senza questo blocco ESLint in flat config non prende in carico i file .ts/.tsx quando gli si
  // passa una directory: di default guarda solo .js, .mjs e .cjs.
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
  },

  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },

  // Determinismo: vale su tutto il codice sorgente di applicazioni e pacchetti, e su `tools/`
  // scritto in TypeScript — dove da M7 vivrà il simulatore di flotta, che sotto test deve
  // avanzare solo su `tick()` espliciti.
  {
    files: ['apps/*/src/**/*.{ts,tsx}', 'packages/*/src/**/*.{ts,tsx}', 'tools/**/*.{ts,tsx}'],
    rules: determinism,
  },

  // Unica eccezione: il modulo platform, che *è* l'adattatore verso orologio e casualità reali.
  {
    files: ['apps/api/src/platform/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off' },
  },

  // I test possono usare i timer di Jest e costruire date esplicite; non possono comunque
  // leggere l'orologio di sistema, perché renderebbe instabile la suite.
  {
    files: ['**/test/**/*.ts', '**/*.spec.ts'],
    rules: determinism,
  },

  // I cancelli di milestone avviano processi veri (server HTTP, dev server dei client) e devono
  // poterli attendere: qui i timer sono ammessi, ed è scritto in HARNESS.md §2 insieme alla
  // regola che deroga. Restano vietati orologio di sistema e casualità, che sono ciò che rende
  // instabile una suite — infatti l'attesa nel cancello M0 conta i tentativi, non i millisecondi.
  {
    files: ['apps/api/test/gates/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...clockAndRandomSelectors],
      'no-restricted-imports': 'off',
    },
  },

  // File di configurazione e strumenti: nessun vincolo di determinismo (HARNESS.md §2).
  {
    files: [
      '*.{js,mjs,cjs,ts}',
      'tools/**/*.{js,mjs,cjs}',
      '**/build.mjs',
      '.claude/hooks/**/*.mjs',
      '**/vite.config.ts',
      '**/jest.config.*',
    ],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
    rules: {
      'no-restricted-syntax': 'off',
      // Gli script di tooling girano in Node: i suoi globali non sono dichiarati qui.
      'no-undef': 'off',
    },
  },
);
