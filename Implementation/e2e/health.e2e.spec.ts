import { expect, test } from '@playwright/test';

/**
 * Test di sistema di M0 (`pnpm verify:e2e`).
 *
 * Il cancello di M0 verifica la catena fino alla chiamata HTTP; questo verifica l'ultimo pezzo,
 * quello che serve un browser per vedere: che lo stato letto da `GET /health` finisca davvero
 * sullo schermo dei due client.
 *
 * Non è un dettaglio pedante. La prima versione di M0 passava tutti i controlli con
 * `packages/shared` compilato solo in CommonJS: il pacchetto si importava senza errori da Nest e
 * da Jest, e falliva *solo* nel browser, a runtime, con "does not provide an export named
 * fetchHealth". Un errore che nessun typecheck e nessun test senza browser può vedere.
 *
 * Gli scenari veri dei due client (richiesta di corsa, cambio strategia) sono il cancello di M8.
 */

const clients = [
  {
    name: 'dashboard operatore',
    slug: 'dashboard-operatore',
    url: process.env.E2E_WEB_URL ?? 'http://localhost:5173/',
    heading: /Dashboard operatore/,
  },
  {
    name: 'app passeggero',
    slug: 'app-passeggero',
    url: process.env.E2E_PASSENGER_URL ?? 'http://localhost:5174/',
    heading: /App passeggero/,
  },
];

test.describe('[M0] I client mostrano lo stato letto da GET /health', () => {
  for (const client of clients) {
    test(`${client.name} mostra lo stato dell'API`, async ({ page }) => {
      await page.goto(client.url);

      await expect(page.getByRole('heading', { name: client.heading })).toBeVisible();
      await expect(page.getByTestId('api-health-status')).toHaveText('ok');

      // Lo screenshot resta a disposizione: serve a controllare il risultato visivo senza
      // rieseguire lo stack (HARNESS.md §1).
      await page.screenshot({ path: `e2e/screenshots/${client.slug}.png`, fullPage: true });
    });
  }
});
