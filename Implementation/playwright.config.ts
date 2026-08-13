import { defineConfig, devices } from '@playwright/test';

/**
 * Configurazione dei test di sistema (`pnpm verify:e2e`).
 *
 * Da M8 gli scenari sono tre: che i due client mostrino lo stato dell'API (M0), che un passeggero
 * richieda una corsa e la veda avanzare fino a `in_ride`, e che un operatore cambi strategia e
 * veda la dashboard passare a Manual. Il cablaggio è quello di M0: un solo comando alza i tre
 * servizi, e il database lo prepara `tools/e2e/run.mjs` prima di arrivare qui.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: false,
  /**
   * Un solo worker, e non è ridondante con `fullyParallel: false`.
   *
   * Quella opzione serializza i test *dentro un file*; i file restano distribuiti sui worker. I tre
   * file di scenari condividono un database, il record `system_mode` e — da M7 — il mondo del
   * simulatore, che vive in memoria: un operatore che porta il sistema in Manual mentre l'altro
   * scenario alloca è un intreccio che nessuno dei due test descrive. Serializzare costa una
   * cinquantina di secondi e toglie una classe di fallimenti intermittenti, che sono la cosa
   * peggiore che possa capitare a una suite (HARNESS.md §2).
   */
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  /**
   * Due minuti per test.
   *
   * Non è generosità: una corsa avanza quando il simulatore si muove e la telemetria lo osserva,
   * e i due `@Cron` girano **ogni dieci secondi** (`FleetTelemetrySchedule`). Il percorso
   * `assigned → arriving → arrived → in_ride` costa quindi almeno tre cicli, e i 30 secondi di
   * default di Playwright non bastano per costruzione. Il test non aspetta un tempo: aspetta che
   * un attributo cambi, e questo è solo il limite oltre il quale si dichiara che non cambierà.
   */
  timeout: 120_000,
  reporter: process.env.CI ? 'list' : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // Un solo comando alza tutti e tre i servizi. L'attesa è sull'API e non sui client di
  // proposito: è il servizio più lento a partire, quindi quando risponde lui i due dev server
  // Vite sono pronti da un pezzo — e senza API i client mostrerebbero un errore, non lo stato.
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:3000/health',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    /**
     * Un tick del simulatore vale un quarto d'ora di mondo simulato invece di un minuto.
     *
     * È lo stesso parametro che `.env.example` documenta, alzato per la durata degli scenari: a
     * 20 km/h un tick copre così cinque chilometri, e un ritiro dentro Milano si raggiunge in un
     * tick solo. Con il valore di default ne servirebbero una decina, cioè cento secondi di
     * attesa per veder partire una corsa — un test lento senza dimostrare nulla di più.
     *
     * Ciò che questo **non** fa è rendere il test dipendente da un tempo: la velocità cambia
     * quanti tick servono, non quale veicolo viene scelto né in quale ordine avvengono le
     * transizioni. La progressione resta quella che la Figura 2.10 prescrive.
     *
     * Attenzione a un caso locale: con `reuseExistingServer` la variabile **non** raggiunge un
     * `pnpm dev` già avviato a mano, che continuerà con il valore del proprio `.env`. Gli scenari
     * passano lo stesso — un ritiro dentro Milano si raggiunge in una decina di tick, e i limiti
     * qui sotto li assorbono — ma la corsa impiega un minuto invece di trenta secondi. In CI non
     * si dà: lì `reuseExistingServer` è falso e il server lo avvia Playwright.
     */
    env: { SIMULATOR_TICK_MINUTES: '15' },
  },
});
