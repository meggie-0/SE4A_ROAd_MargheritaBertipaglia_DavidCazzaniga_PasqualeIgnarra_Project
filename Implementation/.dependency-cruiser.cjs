/**
 * Confini fra moduli — CLAUDE.md Regola 1, HARNESS.md §3.
 *
 * Il senso: un membro del team deve poter riscrivere da zero un singolo modulo, o l'intero
 * frontend, senza toccare nient'altro. Perché sia vero, un modulo dev'essere raggiungibile solo
 * attraverso la sua porta.
 *
 * Due dettagli facili da sbagliare, segnalati in HARNESS.md §3:
 *  - dependency-cruiser interpola dentro `to` i gruppi catturati in `from`, e solo quelli;
 *  - le eccezioni ammesse sono TUTTI i `*.port.ts` alla radice del modulo (al plurale: `platform`
 *    espone `clock.port.ts` e `random.port.ts`) più il `*.module.ts`, che serve agli `imports`
 *    di Nest.
 *
 * Una precisazione rispetto allo snippet di HARNESS.md §3: l'interpolazione va scritta con il
 * gruppo *numerato* (`$1`), non con quello nominato (`$<mod>`). Con dependency-cruiser 17.4.3 la
 * forma nominata dentro `pathNot` non viene sostituita, la regola non riconosce gli import interni
 * al modulo e segnala come violazione ogni file che importa un proprio vicino — cioè fallisce nel
 * modo peggiore, sembrando severa mentre è solo rotta. Verificato sulle due forme, HARNESS.md §3
 * aggiornato di conseguenza.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-cross-module-internals',
      comment:
        'Un modulo è raggiungibile solo dalle sue porte (*.port.ts) e dal suo modulo Nest ' +
        '(*.module.ts). Se stai attraversando un confine in altro modo, stai sbagliando qualcosa.',
      severity: 'error',
      from: { path: '^apps/api/src/([^/]+)/' },
      to: {
        path: '^apps/api/src/[^/]+/',
        pathNot: [
          '^apps/api/src/$1/', // dentro lo stesso modulo: libero
          '^apps/api/src/[^/]+/[^/]+\\.port\\.ts$', // le porte
          '^apps/api/src/[^/]+/[^/]+\\.module\\.ts$', // i moduli Nest
        ],
      },
    },
    {
      name: 'no-cross-module-internals-from-src-root',
      comment:
        'Stessa regola, per i file che stanno direttamente sotto src/ (main.ts, app.module.ts, ' +
        'openapi.ts): il `from` della regola precedente pretende un segmento di cartella e non ' +
        'li coprirebbe.',
      severity: 'error',
      from: { path: '^apps/api/src/[^/]+\\.ts$' },
      to: {
        path: '^apps/api/src/[^/]+/',
        pathNot: [
          '^apps/api/src/[^/]+/[^/]+\\.port\\.ts$',
          '^apps/api/src/[^/]+/[^/]+\\.module\\.ts$',
        ],
      },
    },
    {
      name: 'tests-reach-modules-only-through-ports',
      comment:
        'CLAUDE.md Regola 1 dice «nessun file fuori da src/<modulo>/», e i test non sono ' +
        "un'eccezione: un test che inietta AllocationManager invece di AllocationPort smette di " +
        'dimostrare che il modulo è sostituibile (HARNESS.md §9). Unica deroga: `platform`, ' +
        'perché FakeClock e FixedRandom *sono* i doppi che i test devono poter costruire.',
      severity: 'error',
      from: { path: '^apps/api/test/' },
      to: {
        path: '^apps/api/src/[^/]+/',
        pathNot: [
          '^apps/api/src/platform/',
          '^apps/api/src/[^/]+/[^/]+\\.port\\.ts$',
          '^apps/api/src/[^/]+/[^/]+\\.module\\.ts$',
        ],
      },
    },
    {
      name: 'simulator-only-behind-the-port',
      comment:
        'Il simulatore di flotta (@road/simulator, tools/simulator) è un fornitore esterno: si ' +
        "raggiunge solo dall'adapter che lo avvolge, dentro src/external/. Se un manager di " +
        'dominio potesse importarlo saprebbe che la flotta è simulata — cioè saprebbe una cosa ' +
        'che con veicoli veri sarebbe falsa, ed è esattamente ciò che NFR8 vieta (DD §4.3).',
      severity: 'error',
      from: { pathNot: '^(apps/api/src/external/|tools/simulator/)' },
      to: { path: '^tools/simulator/' },
    },
    {
      name: 'no-circular',
      comment: 'Nessuna dipendenza circolare fra moduli.',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'shared-is-a-leaf',
      comment: 'packages/shared è una foglia: le applicazioni dipendono da lui, mai il contrario.',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: { path: '^apps/' },
    },
    {
      name: 'frontend-never-imports-backend',
      comment:
        'I client parlano con il backend solo tramite il contratto HTTP (contracts/openapi.json) ' +
        'e i tipi di packages/shared. Questo è ciò che li rende sostituibili.',
      severity: 'error',
      from: { path: '^apps/(web|passenger)/' },
      to: { path: '^apps/api/' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    /**
     * Le cartelle di build si escludono dal grafo — con **un'eccezione voluta**.
     *
     * `tools/simulator/dist` resta dentro: è lì che `@road/simulator` viene risolto, perché il
     * pacchetto pubblica il proprio artefatto compilato. Escludendolo come gli altri, la regola
     * `simulator-only-behind-the-port` non avrebbe niente da vedere e passerebbe sempre —
     * sembrando una protezione mentre non lo è, che è il difetto contro cui mette in guardia
     * HARNESS.md §3. Verificato togliendo l'eccezione: con essa un import proibito fallisce, senza
     * di essa nessuno se ne accorge.
     */
    exclude: { path: '(^|/)(coverage|\\.tsbuild)/|^(apps|packages)/[^/]+/dist/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['require', 'node', 'import', 'default'],
      extensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
