/**
 * Un file di configurazione, cinque progetti Jest. Ognuno corrisponde a un passo di
 * `pnpm verify` (HARNESS.md §1) e può essere eseguito da solo con `--selectProjects`.
 *
 *  unit         logica di dominio, niente I/O
 *  arch         il test che legge gli `exports` dei @Module (HARNESS.md §3)
 *  contract     rigenera l'OpenAPI e lo confronta con contracts/openapi.json (HARNESS.md §4)
 *  gate         i cancelli di milestone (HARNESS.md §6)
 *  integration  catene fra moduli su Postgres reale (Testcontainers), da M1 in poi
 *
 * Il progetto `integration` viene invocato con `--passWithNoTests`: finché M1 non arriva la sua
 * suite è vuota, e una suite vuota non è un fallimento — è una milestone non ancora scritta.
 */

const transform = {
  '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
};

const common = {
  testEnvironment: 'node',
  transform,
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  // `packages/shared` scrive gli import relativi con estensione `.js`, perché è ciò che rende
  // valido il suo output ES module. Il resolver di Jest cerca il file letteralmente e non lo
  // trova: qui l'estensione viene tolta, così risolve il `.ts` sorgente.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  clearMocks: true,
  restoreMocks: true,
};

export default {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: [
        '<rootDir>/apps/api/test/unit/**/*.spec.ts',
        '<rootDir>/packages/*/test/**/*.spec.ts',
        // Il simulatore di flotta (M7) è un pacchetto, non un modulo dell'API: i suoi test lo
        // costruiscono direttamente, come quelli di @road/shared, e non attraversano nessuna porta.
        '<rootDir>/tools/*/test/**/*.spec.ts',
        /*
         * I due client (M8), nominati uno per uno e non con `apps/*`: quel jolly prenderebbe anche
         * `apps/api/test/integration` e `apps/api/test/gates`, che sono altri due progetti e
         * pretendono Docker — finirebbero eseguiti due volte, e il passo `unit` smetterebbe di
         * essere quello veloce senza I/O.
         *
         * Ciò che si prova è la logica **pura** dei client: la proiezione delle due macchine a
         * stati sulla vista del passeggero e la classificazione degli alert dell'operatore.
         * Nessuno dei due test monta un componente — non c'è un DOM in questo progetto, e non
         * serve: ciò che può sbagliare in silenzio è il calcolo, non il markup. Il difetto che ha
         * motivato il secondo è proprio di quel genere — un filtro troppo stretto non solleva,
         * mostra di meno.
         */
        '<rootDir>/apps/web/test/**/*.spec.ts',
        '<rootDir>/apps/passenger/test/**/*.spec.ts',
      ],
    },
    {
      ...common,
      displayName: 'arch',
      testMatch: ['<rootDir>/apps/api/test/arch/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'contract',
      testMatch: ['<rootDir>/apps/api/test/contract/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'gate',
      testMatch: ['<rootDir>/apps/api/test/gates/**/*.gate.spec.ts'],
      // I cancelli avviano processi veri (server HTTP, dev server dei client): serve aria.
      testTimeout: 120_000,
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/apps/api/test/integration/**/*.spec.ts'],
      testTimeout: 120_000,
    },
  ],
};
