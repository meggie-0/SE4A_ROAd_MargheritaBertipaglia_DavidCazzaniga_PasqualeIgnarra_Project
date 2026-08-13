import { expect, test, type Page } from '@playwright/test';

/**
 * Scenario di sistema di M8: **un operatore cambia strategia e vede la dashboard passare a
 * Manual** (MILESTONES.md §M8, HARNESS.md §6).
 *
 * È la seconda metà del criterio di completamento. Ciò che solo un browser può dimostrare è che
 * l'indicatore di modo che NFR10 vuole «always visible» lo sia davvero, e che si aggiorni: il
 * cancello di M6 prova che il *backend* passa in Manual, non che l'operatore lo veda.
 *
 * Il test lascia il sistema come l'ha trovato — in modo Auto — perché la suite gira in sequenza
 * su un database condiviso, e un modo Manual lasciato acceso sospenderebbe gli switch automatici
 * per chiunque venga dopo.
 */

const DASHBOARD_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173/';

/** Le credenziali di sviluppo che `pnpm db:seed` crea (`.env.example`, sezione seed). */
const OPERATOR = {
  email: process.env.SEED_OPERATOR_EMAIL ?? 'operatore@road.example',
  password: process.env.SEED_OPERATOR_PASSWORD ?? 'operatore-di-sviluppo',
};

async function signIn(page: Page): Promise<void> {
  await page.goto(DASHBOARD_URL);
  await page.getByTestId('email').fill(OPERATOR.email);
  await page.getByTestId('password').fill(OPERATOR.password);
  await page.getByTestId('submit-auth').click();
  await expect(page.getByTestId('control-mode')).toBeVisible();
}

test.describe('[R7][R8][R13][G5][G8][NFR10] La dashboard mostra la flotta e governa la strategia', () => {
  test('una scelta manuale porta la dashboard in Manual, e il rientro in Auto la riporta indietro', async ({
    page,
  }) => {
    await signIn(page);

    // Il sistema parte in Auto (RASD §2.4). Se una esecuzione precedente lo avesse lasciato in
    // Manual, lo si riporta in Auto prima di cominciare: lo scenario è «da Auto a Manual».
    const mode = page.getByTestId('control-mode');
    if ((await mode.getAttribute('data-mode')) === 'MANUAL') {
      await page.getByTestId('enable-auto').click();
    }
    await expect(mode).toHaveAttribute('data-mode', 'AUTO');

    // La scelta manuale di una strategia: R13 lega le due cose, e non c'è un pulsante «passa a
    // Manual» da premere.
    await page.getByTestId('select-strategy-MINIMUM_ETA').click();

    await expect(mode).toHaveAttribute('data-mode', 'MANUAL');
    await expect(page.getByTestId('active-strategy')).toHaveAttribute(
      'data-strategy',
      'MINIMUM_ETA',
    );

    await page.screenshot({ path: 'e2e/screenshots/dashboard-modo-manuale.png', fullPage: true });

    // Il rientro in Auto è esplicito, come NFR10 pretende: finché non lo si chiede, nessun livello
    // di traffico rimette il sistema in automatico.
    await page.getByTestId('enable-auto').click();
    await expect(mode).toHaveAttribute('data-mode', 'AUTO');
  });

  test('[NFR6] modo e strategia attiva si vedono al primo render, senza navigare', async ({
    page,
  }) => {
    /*
     * La seconda metà di NFR6 nella formulazione del DD §4.3: «the operator sees mode and active
     * strategy on the dashboard's first render, **without navigating**».
     *
     * «Senza navigare» si verifica non navigando: dopo il login non si preme nient'altro, e i due
     * indicatori devono già portare un valore. Il test fallirebbe se fossero dietro una scheda,
     * un menù o una seconda richiesta da innescare a mano.
     */
    await signIn(page);

    await expect(page.getByTestId('control-mode')).toHaveAttribute('data-mode', /AUTO|MANUAL/);
    await expect(page.getByTestId('active-strategy')).toHaveAttribute(
      'data-strategy',
      /NEAREST_AVAILABLE|MINIMUM_ETA/,
    );
  });

  test('[R7][G8] la mappa e la status bar mostrano la flotta viva', async ({ page }) => {
    await signIn(page);

    // La status bar riassume la flotta per stato: il totale viene dal seed, che carica 20 veicoli.
    const total = page.getByTestId('fleet-total');
    await expect(total).not.toHaveText('—');
    expect(Number.parseInt((await total.innerText()).trim(), 10)).toBeGreaterThan(0);

    // Tutti e sette gli stati della Figura 2.10 sono presenti, zeri compresi: una barra che
    // mostrasse solo quelli occupati cambierebbe forma a ogni aggiornamento.
    for (const state of [
      'AVAILABLE',
      'ASSIGNED',
      'ARRIVING',
      'ARRIVED',
      'IN_RIDE',
      'REBALANCING',
      'MAINTENANCE',
    ]) {
      await expect(page.getByTestId(`tally-${state}`)).toBeVisible();
    }

    // I marker dei veicoli sono sulla mappa: la flotta si *vede*, che è ciò che R7 chiede.
    await expect(page.locator('.fleet-map path.leaflet-interactive').first()).toBeVisible();

    await page.screenshot({
      path: 'e2e/screenshots/dashboard-operatore-flotta.png',
      fullPage: true,
    });
  });
});
