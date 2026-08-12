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
