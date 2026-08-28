import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * SPIKE — Scenario 1 del RASD: la corsa immediata, dall'inizio alla fine, con gli screenshot.
 *
 * Non è codice finito: serve a misurare quanto costa uno scenario di dimostrazione.
 */

const PASSENGER_URL = process.env.E2E_PASSENGER_URL ?? 'http://localhost:5174/';
const DASHBOARD_URL = process.env.E2E_WEB_URL ?? 'http://localhost:5173/';

const OPERATOR = {
  email: process.env.SEED_OPERATOR_EMAIL ?? 'operatore@road.example',
  password: process.env.SEED_OPERATOR_PASSWORD ?? 'operatore-di-sviluppo',
};

const PICKUP_FRACTION = { x: 0.45, y: 0.5 };
const DESTINATION_FRACTION = { x: 0.62, y: 0.42 };

/** Le fasi che il passeggero attraversa, nell'ordine della Figura 2.10. */
const PROGRESSIONE = ['searching', 'assigned', 'arriving', 'arrived', 'in_ride'] as const;

let passo = 0;

/** Uno scatto numerato, così l'ordine è leggibile dal nome del file. */
async function scatta(page: Page, nome: string): Promise<void> {
  passo += 1;
  await page.screenshot({
    path: `e2e/screenshots/demo/scenario-1/${String(passo).padStart(2, '0')}-${nome}.png`,
    fullPage: true,
  });
}

async function tapMap(page: Page, fraction: { x: number; y: number }): Promise<void> {
  const map = page.locator('.ride-map');
  const box = await map.boundingBox();
  if (box === null) throw new Error('La mappa non è visibile.');
  await map.click({ position: { x: box.width * fraction.x, y: box.height * fraction.y } });
}

test('Scenario 1 — corsa immediata', async ({ browser }) => {
  // ---- 1. L'operatore guarda la flotta -------------------------------------
  const operatore = await browser.newPage();
  await operatore.goto(DASHBOARD_URL);
  await operatore.getByTestId('email').fill(OPERATOR.email);
  await operatore.getByTestId('password').fill(OPERATOR.password);
  await operatore.getByTestId('submit-auth').click();
  await expect(operatore.getByTestId('control-mode')).toBeVisible();
  await scatta(operatore, 'operatore-flotta-a-riposo');

  // ---- 2. Il passeggero si registra ----------------------------------------
  const passeggero = await browser.newPage();
  await passeggero.goto(PASSENGER_URL);
  await passeggero.getByTestId('toggle-auth-mode').click();
  await passeggero.getByTestId('name').fill('Elena');
  await passeggero.getByTestId('surname').fill('Conti');
  await passeggero.getByTestId('email').fill(`demo-${randomUUID()}@road.example`);
  await passeggero.getByTestId('password').fill('passeggero-di-prova');
  await passeggero.getByTestId('submit-auth').click();
  await expect(passeggero.getByTestId('passenger-name')).toHaveText('Elena');
  await scatta(passeggero, 'passeggero-entrato');

  // ---- 3. Sceglie ritiro e destinazione ------------------------------------
  await passeggero.getByTestId('route-search-preview').click();
  await expect(passeggero.getByTestId('pickup-address')).toBeVisible();

  await tapMap(passeggero, PICKUP_FRACTION);
  await expect(passeggero.getByTestId('pickup-address')).not.toHaveValue('', { timeout: 30_000 });
  await scatta(passeggero, 'ritiro-scelto');

  await tapMap(passeggero, DESTINATION_FRACTION);
  await expect(passeggero.getByTestId('kind-immediate')).toBeChecked({ timeout: 30_000 });
  await scatta(passeggero, 'destinazione-scelta');

  // ---- 4. Richiede la corsa ------------------------------------------------
  await passeggero.getByTestId('request-ride').click();

  const fase = passeggero.getByTestId('ride-phase');
  await expect(fase).toBeVisible();
  await expect(passeggero.getByTestId('ride-robotaxi')).not.toHaveText('—');
  await scatta(passeggero, 'corsa-assegnata');

  // ---- 5. Segue la progressione, fotografando ogni fase nuova --------------
  //
  // Il punto delicato dell'intero scenario: le fasi non durano abbastanza per essere fotografate
  // una per una con delle asserzioni puntuali. Si campiona e si scatta quando la fase cambia.
  const viste: string[] = [];
  await expect
    .poll(
      async () => {
        const corrente = await fase.getAttribute('data-phase');
        if (corrente !== null && viste.at(-1) !== corrente) {
          viste.push(corrente);
          await scatta(passeggero, `fase-${corrente}`);
        }
        return corrente;
      },
      { timeout: 120_000, intervals: [50] },
    )
    .toBe('in_ride');

  // ---- 6. L'operatore vede la stessa corsa dal suo lato --------------------
  await scatta(operatore, 'operatore-corsa-in-corso');

  // ---- 7. La corsa si completa --------------------------------------------
  await expect
    .poll(
      async () => {
        const corrente = await fase.getAttribute('data-phase');
        if (corrente !== null && viste.at(-1) !== corrente) {
          viste.push(corrente);
          await scatta(passeggero, `fase-${corrente}`);
        }
        return corrente;
      },
      { timeout: 180_000, intervals: [200] },
    )
    .toBe('completed');

  await scatta(passeggero, 'corsa-completata');
  await scatta(operatore, 'operatore-flotta-dopo');

  // La progressione è quella legale, senza salti all'indietro.
  const posizioni = viste
    .filter((f) => (PROGRESSIONE as readonly string[]).includes(f))
    .map((f) => (PROGRESSIONE as readonly string[]).indexOf(f));
  expect([...posizioni].sort((a, b) => a - b)).toEqual(posizioni);

  console.log(`FASI VISTE: ${viste.join(' → ')}`);
});
