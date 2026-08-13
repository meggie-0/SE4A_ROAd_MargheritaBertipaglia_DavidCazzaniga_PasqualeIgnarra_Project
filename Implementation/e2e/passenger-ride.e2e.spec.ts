import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * Scenario di sistema di M8: **un passeggero richiede una corsa e la segue fino a `in_ride`**
 * (MILESTONES.md §M8, HARNESS.md §6).
 *
 * È il criterio di completamento della milestone, e serve un browser vero per verificarlo: tutto
 * ciò che sta sotto — allocazione, macchina a stati, canale push — è già coperto dai cancelli
 * precedenti su HTTP e su porte. Quello che solo qui si vede è che l'app passeggero *mostri*
 * quella progressione, e che la mostri **senza interrogare il backend**: dopo la richiesta il
 * client non fa più una sola chiamata: gli aggiornamenti li porta la socket (NFR2).
 *
 * Il test guida l'interfaccia e non l'API: nessuna `fetch` diretta se non quelle necessarie a
 * costruire un passeggero, che è una precondizione dello scenario e non lo scenario.
 */

const PASSENGER_URL = process.env.E2E_PASSENGER_URL ?? 'http://localhost:5174/';
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

/**
 * Un passeggero nuovo per ogni esecuzione.
 *
 * L'indirizzo è unico perché il vincolo di unicità è del database e la suite non svuota le tabelle
 * fra un'esecuzione e l'altra: un indirizzo fisso funzionerebbe la prima volta e fallirebbe la
 * seconda. `randomUUID()` e non `Math.random()`, che il lint vieta e che non garantisce l'unicità.
 */
function freshPassenger(): { email: string; password: string; name: string; surname: string } {
  return {
    email: `e2e-${randomUUID()}@road.example`,
    password: 'passeggero-di-prova',
    name: 'Elena',
    surname: 'Conti',
  };
}

/**
 * Due punti dentro Milano, distanti quanto basta perché la corsa sia una corsa.
 *
 * Sono espressi in frazioni del riquadro della mappa e non in coordinate: il test tocca lo schermo,
 * come farebbe una persona, e il client traduce il tocco in coordinate. Entrambi cadono nel centro
 * della città, dove il seed distribuisce dei veicoli.
 */
const PICKUP_FRACTION = { x: 0.45, y: 0.5 };
const DESTINATION_FRACTION = { x: 0.62, y: 0.42 };

/**
 * Registra un passeggero dall'interfaccia e lascia la sessione nel browser.
 *
 * Restituisce le credenziali usate: servono al solo scenario che ha bisogno di **rientrare** con lo
 * stesso account per distinguere ciò che il backend ha scritto da ciò che il browser ricorda.
 */
async function signIn(page: Page): Promise<ReturnType<typeof freshPassenger>> {
  await page.goto(PASSENGER_URL);

  await page.getByTestId('toggle-auth-mode').click();
  const passenger = freshPassenger();
  await page.getByTestId('name').fill(passenger.name);
  await page.getByTestId('surname').fill(passenger.surname);
  await page.getByTestId('email').fill(passenger.email);
  await page.getByTestId('password').fill(passenger.password);
  await page.getByTestId('submit-auth').click();

  await expect(page.getByTestId('passenger-name')).toHaveText(passenger.name);
  return passenger;
}

/** Tocca la mappa nel punto indicato, in frazioni del suo riquadro. */
async function tapMap(page: Page, fraction: { x: number; y: number }): Promise<void> {
  const map = page.locator('.ride-map');
  const box = await map.boundingBox();
  if (box === null) throw new Error('La mappa non è visibile: nessun riquadro da toccare.');

  await map.click({ position: { x: box.width * fraction.x, y: box.height * fraction.y } });
}

test.describe('[R3][R6][G2][G7] Il passeggero richiede una corsa e ne segue lo stato', () => {
  test('la corsa avanza fino a in_ride sotto gli occhi del passeggero', async ({ page }) => {
    await signIn(page);

    // Ritiro e destinazione si scelgono toccando la mappa (DD §3.1).
    await tapMap(page, PICKUP_FRACTION);
    await expect(page.getByTestId('pickup-value')).not.toHaveText('—');
    await tapMap(page, DESTINATION_FRACTION);
    await expect(page.getByTestId('destination-value')).not.toHaveText('—');

    // Un solo pulsante, come il DD §3.1 prescrive.
    await page.getByTestId('request-ride').click();

    // La stessa schermata diventa vista di stato: il pannello di richiesta sparisce.
    const phase = page.getByTestId('ride-phase');
    await expect(phase).toBeVisible();
    await expect(page.getByTestId('request-ride')).toHaveCount(0);

    // Un veicolo è stato assegnato: è l'esito di R5, visto dal passeggero.
    await expect(phase).toHaveAttribute('data-phase', 'assigned');
    await expect(page.getByTestId('ride-robotaxi')).not.toHaveText('—');

    /*
     * Da qui in poi **nessuna richiesta parte dal client**: la progressione arriva sul canale push.
     *
     * È la falsificazione di NFR2 come il DD §4.3 la formula — «the client only learns of the
     * change by issuing a new request» —, e si controlla contando le richieste all'API dal
     * momento in cui la corsa è stata accettata. Se il client ripiegasse su un'interrogazione
     * periodica, questo contatore crescerebbe e il test fallirebbe pur con la schermata giusta.
     *
     * Il traffico di `/socket.io/` è escluso dal conto, ed è il contrario di una scappatoia: **è**
     * il canale push, e su un trasporto che ripiega su long-polling passa da richieste HTTP. Se
     * contassero, il test fallirebbe per il funzionamento del canale invece che per la sua assenza,
     * cioè accuserebbe esattamente il meccanismo che deve dimostrare.
     */
    const polled: string[] = [];
    await page.route(`${API_URL}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (!path.startsWith('/socket.io/')) polled.push(path);
      await route.continue();
    });

    await expect(phase).toHaveAttribute('data-phase', 'arriving', { timeout: 90_000 });
    await expect(phase).toHaveAttribute('data-phase', 'arrived', { timeout: 90_000 });
    await expect(phase).toHaveAttribute('data-phase', 'in_ride', { timeout: 90_000 });

    // L'elenco e non il contatore: se fallisse, il messaggio dice *quale* rotta è stata
    // interrogata, che è l'informazione con cui si corregge il difetto.
    expect(polled).toEqual([]);

    // Lo screenshot resta a disposizione: serve a controllare il risultato visivo senza
    // rieseguire lo stack (HARNESS.md §1).
    await page.screenshot({
      path: 'e2e/screenshots/passeggero-corsa-in-corso.png',
      fullPage: true,
    });
  });
});

test.describe('[R2][G1] Il passeggero aggiorna il proprio profilo', () => {
  /**
   * R2: «users will be able to update their personal information **and credentials**».
   *
   * Il backend lo realizza dal M1b, ma fino a M8 non c'era modo di raggiungerlo se non chiamando
   * `PATCH /auth/me` a mano: `MILESTONES.md` §M8 elenca R2 fra i requisiti coperti dai client, ed è
   * questa schermata a coprirlo.
   */
  test('il nome cambiato sopravvive a un nuovo accesso', async ({ page }) => {
    const passenger = await signIn(page);

    await page.getByTestId('open-profile').click();
    await page.getByTestId('profile-name').fill('Elisabetta');
    await page.getByTestId('save-profile').click();

    await expect(page.getByTestId('profile-saved')).toBeVisible();
    // L'intestazione mostra subito il nome nuovo: la sessione conservata è stata riscritta.
    await expect(page.getByTestId('passenger-name')).toHaveText('Elisabetta');

    /*
     * E il cambiamento è nel **backend**, non solo nel deposito del browser.
     *
     * Il modo di distinguere le due cose è uscire e rientrare: un semplice ricaricamento
     * rileggerebbe la sessione conservata e mostrerebbe il nome nuovo anche se la `PATCH` non
     * avesse scritto niente. Rifare l'accesso costringe il nome a tornare dal database.
     */
    await page.getByTestId('sign-out').click();
    await page.getByTestId('email').fill(passenger.email);
    await page.getByTestId('password').fill(passenger.password);
    await page.getByTestId('submit-auth').click();

    await expect(page.getByTestId('passenger-name')).toHaveText('Elisabetta');
  });
});

test.describe('[NFR6] La richiesta di una corsa costa al più quattro interazioni', () => {
  /**
   * NFR6 nella formulazione falsificabile del DD §4.3: «a passenger completes a ride request from a
   * **cold start** of the client in at most four interactions».
   *
   * «Avvio a freddo» è il ricaricamento della pagina con una sessione già stabilita: il login non è
   * una delle quattro interazioni, o nessuna interfaccia potrebbe rispettare il vincolo. Il conto
   * qui è esplicito, e il test fallisce sia se le interazioni fossero cinque sia se con tre non si
   * arrivasse a una corsa richiesta — che è l'altra metà del requisito.
   */
  test('da avvio a freddo bastano tre tocchi: ritiro, destinazione, richiesta', async ({
    page,
  }) => {
    await signIn(page);

    // L'avvio a freddo: la pagina si ricarica e la sessione sopravvive, quindi si riparte dalla
    // mappa e non dal login. Se non sopravvivesse, `request-ride` non esisterebbe e il test
    // fallirebbe qui.
    await page.reload();
    await expect(page.getByTestId('request-ride')).toBeVisible();

    /*
     * Le interazioni sono **un elenco eseguito**, non un contatore incrementato a mano.
     *
     * La differenza è che qui il numero non si può sbagliare: `interactions.length` è il numero di
     * azioni che il test compie davvero, quindi chi un domani dovesse aggiungere un passo per far
     * funzionare lo scenario dovrebbe aggiungerlo a questo elenco, e l'asserzione lo coglierebbe.
     * Un contatore scritto a parte, invece, resta al valore che l'autore gli assegna: era
     * un'asserzione che non poteva fallire.
     */
    const interactions: readonly (() => Promise<void>)[] = [
      () => tapMap(page, PICKUP_FRACTION),
      () => tapMap(page, DESTINATION_FRACTION),
      () => page.getByTestId('request-ride').click(),
    ];

    // La corsa immediata è già selezionata: sceglierla non costa un'interazione, e se un giorno
    // smettesse di essere il default il bilancio salirebbe a quattro senza che nessuno se ne accorga.
    await expect(page.getByTestId('kind-immediate')).toBeChecked();

    for (const interaction of interactions) await interaction();

    await expect(page.getByTestId('ride-phase')).toBeVisible();
    expect(interactions.length).toBeLessThanOrEqual(4);
  });
});
