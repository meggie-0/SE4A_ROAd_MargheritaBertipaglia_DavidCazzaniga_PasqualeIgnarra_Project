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

    /*
     * [R12][R13] Il comando **non svuota** l'indicatore del traffico.
     *
     * L'evento che porta il modo non porta necessariamente un livello — una scelta manuale è una
     * decisione umana, non un'osservazione — e finché quel valore veniva riscritto ricostruendo
     * l'oggetto in cache da zero, prendere il controllo della flotta cancellava dallo schermo un
     * livello perfettamente valido. Che è il contrario di ciò che serve: in Manual le osservazioni
     * continuano a registrarsi (D20), e sono l'unica cosa che dice all'operatore se il suo
     * intervento ha ancora senso.
     *
     * Non si asserisce **quale** livello: dipenderebbe dall'ora in cui la suite gira, ed è la stessa
     * ragione per cui il caso qui sotto accetta i quattro valori.
     */
    const traffic = page.getByTestId('traffic-level');
    await expect(traffic).toBeVisible();
    await expect(traffic).toHaveAttribute('data-traffic', /LOW|MEDIUM|HIGH|unknown/);
    await expect(traffic).not.toHaveText('');

    await page.screenshot({ path: 'e2e/screenshots/dashboard-modo-manuale.png', fullPage: true });

    // Il rientro in Auto è esplicito, come NFR10 pretende: finché non lo si chiede, nessun livello
    // di traffico rimette il sistema in automatico.
    await page.getByTestId('enable-auto').click();
    await expect(mode).toHaveAttribute('data-mode', 'AUTO');
  });

  test('[NFR6][R12] modo, strategia attiva e traffico si vedono al primo render, senza navigare', async ({
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

    /*
     * Il livello di traffico, alla stessa condizione (RASD §2.3: «a clear overview of traffic
     * levels»).
     *
     * `unknown` è fra i valori ammessi e non è una concessione: se nessuna osservazione è ancora
     * arrivata l'indicatore **deve** dire proprio quello invece di mostrare un livello che nessuno
     * ha misurato. Ciò che il caso pretende è che l'indicatore ci sia e porti uno dei quattro stati
     * previsti, non che il traffico sia in una condizione particolare — che dipenderebbe dall'ora
     * in cui la suite gira.
     */
    const traffic = page.getByTestId('traffic-level');
    await expect(traffic).toBeVisible();
    await expect(traffic).toHaveAttribute('data-traffic', /LOW|MEDIUM|HIGH|unknown/);

    // Il colore non basta: l'etichetta testuale accompagna sempre la pastiglia.
    await expect(traffic).not.toHaveText('');
  });

  test('[R7][G8] la mappa e la status bar mostrano la flotta viva', async ({ page }) => {
    await signIn(page);

    // La status bar riassume la flotta per stato: il totale viene dal seed, che carica 64 veicoli.
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

    // I marker dei **veicoli** sono sulla mappa: la flotta si *vede*, che è ciò che R7 chiede.
    // Il selettore nomina `data-robotaxi-id`, che solo i veicoli portano: le sedici zone hanno i
    // propri marker sulla stessa mappa, e un selettore più generico passerebbe a flotta vuota.
    const markers = page.locator('.fleet-map [data-robotaxi-id]');
    await expect(markers.first()).toBeVisible();
    expect(await markers.count()).toBe(Number.parseInt((await total.innerText()).trim(), 10));

    await page.screenshot({
      path: 'e2e/screenshots/dashboard-operatore-flotta.png',
      fullPage: true,
    });
  });

  test('[R9][NFR2][NFR5] l operatore gestisce la manutenzione dalla dashboard', async ({
    page,
  }) => {
    await signIn(page);

    const maintenancePanel = page.getByTestId('maintenance-panel');
    /*
     * `data-state` identifica i veicoli AVAILABLE.
     *
     * Prima si selezionava sul riempimento verde del cerchio, cioè su una **scelta di palette**: il
     * test si è rotto quando i marker sono passati da cerchio SVG a badge HTML, e si sarebbe rotto
     * ugualmente al primo cambio di tinta, che non ha niente a che vedere con ciò che il caso
     * verifica. Lo stato del dominio nell'attributo è la stessa convenzione di `data-mode`,
     * `data-strategy` e `data-traffic`.
     *
     * `dispatchEvent` invia il click direttamente al marker scelto:
     * un click fisico potrebbe essere intercettato da un altro marker
     * sovrapposto sulla stessa zona.
     */
    const availableMarker = page.locator('.fleet-map [data-state="AVAILABLE"]').first();

    await expect(availableMarker).toBeVisible();
    await availableMarker.dispatchEvent('click');
    await expect(maintenancePanel).toHaveAttribute('data-robotaxi-state', 'AVAILABLE');

    const selectedRobotaxiId = page.getByTestId('selected-robotaxi-id');

    await expect(selectedRobotaxiId).not.toHaveText('');

    const maintenanceCount = page.getByTestId('tally-MAINTENANCE').locator('.figure');

    const countBefore = Number.parseInt((await maintenanceCount.innerText()).trim(), 10);

    await page.getByTestId('maintenance-reason').fill('Controllo automatico Playwright');

    await page.getByTestId('start-maintenance').click();

    await expect(maintenancePanel).toHaveAttribute('data-robotaxi-state', 'MAINTENANCE');

    await expect(maintenanceCount).toHaveText(String(countBefore + 1));

    await expect(page.getByTestId('complete-maintenance')).toBeVisible();

    await page.screenshot({
      path: 'e2e/screenshots/dashboard-manutenzione.png',
      fullPage: true,
    });

    /*
     * Il test lascia il sistema come lo ha trovato, così non influenza
     * gli scenari eseguiti successivamente sullo stesso database.
     */
    await page.getByTestId('complete-maintenance').click();

    await expect(maintenancePanel).toHaveAttribute('data-robotaxi-state', 'AVAILABLE');

    await expect(maintenanceCount).toHaveText(String(countBefore));

    await expect(page.getByTestId('start-maintenance')).toBeVisible();
  });
});

test.describe('[R2][G1] L operatore aggiorna il proprio profilo', () => {
  /**
   * R2 attribuisce agli **utenti** — non ai soli passeggeri — la facoltà di aggiornare dati
   * personali e credenziali, e un operatore è un utente (DD §3.2 [v1.6], decisione D70).
   *
   * Il test **non cambia la password**, di proposito: le credenziali dell'operatore vengono dal
   * seed e sono le stesse che ogni altro scenario usa per entrare. Cambiarle qui renderebbe la
   * suite dipendente dall'ordine di esecuzione, che è ciò che HARNESS.md §2 vieta.
   */
  test('il pannello profilo salva senza far sparire la superficie di monitoraggio', async ({
    page,
  }) => {
    await signIn(page);

    /*
     * Il profilo si raggiunge in **due** passi: prima il menu, poi la voce.
     *
     * È un cambiamento voluto del redesign, e non intacca NFR6: quel requisito pretende che modo e
     * strategia si vedano al primo render senza navigare, e il profilo non è fra quelli — non è
     * superficie di comando e controllo, è l'account di chi guarda. Ciò che resta verificato qui
     * sotto è la parte che conta, cioè che aprendolo la console non sparisca.
     */
    await page.getByTestId('open-menu').click();
    await page.getByTestId('open-profile').click();

    /*
     * La superficie di monitoraggio resta: mappa, status bar **e pannello strategia**.
     *
     * Prima il profilo prendeva il posto di tutti i pannelli laterali, e questo caso asseriva che il
     * toggle di modo sparisse. Il redesign gli fa prendere il posto del solo pannello manutenzione,
     * e il modo resta a schermo: è un miglioramento rispetto a NFR10, che lo vuole «always visible»,
     * non un cambiamento da assecondare in silenzio. L'asserzione è quindi rovesciata di proposito.
     */
    await expect(page.locator('.fleet-map')).toBeVisible();
    await expect(page.getByTestId('fleet-status-bar')).toBeVisible();
    await expect(page.getByTestId('control-mode')).toBeVisible();
    await expect(page.getByTestId('maintenance-panel')).toHaveCount(0);

    await page.getByTestId('profile-phone').fill('+39 02 1234567');
    await page.getByTestId('save-profile').click();
    await expect(page.getByTestId('profile-saved')).toBeVisible();

    // Chiuso il pannello, la manutenzione torna al suo posto.
    await page.getByTestId('close-profile').click();
    await expect(page.getByTestId('maintenance-panel')).toBeVisible();
  });
});
