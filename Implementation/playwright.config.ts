import { defineConfig, devices } from '@playwright/test';

/**
 * Configurazione dei test di sistema (`pnpm verify:e2e`).
 *
 * In M0 c'è un solo scenario: che i due client mostrino lo stato dell'API. Gli scenari di dominio
 * (richiesta di corsa, cambio strategia, rebalancing) arrivano da M8, e questo cablaggio non
 * dovrà cambiare per accoglierli.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
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
  },
});
