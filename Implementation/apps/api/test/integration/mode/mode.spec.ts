import type { StrategyName, TrafficLevel } from '@road/shared';

import { recordOperator } from '../../support/notifications';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * `ModeController`: isteresi, modo Manual e rientro in Auto (M6, RASD R12 e R13; NFR9, NFR10).
 *
 * Gira su **Postgres vero**: serve Docker in esecuzione. Non è pignoleria. Ciò che questi casi
 * devono dimostrare è che modo e strategia vivano in un **record persistito** e non nella memoria
 * di un processo — è la decisione D6, ed è la sola ragione per cui due repliche del tier
 * applicativo non divergono (NFR3). Su un doppio in memoria passerebbe anche una versione che
 * tiene i due valori in un campo privato, cioè esattamente quella che il documento esclude.
 *
 * I livelli di traffico li passa il test, uno per volta, a `ModePort.onTrafficLevel()`. È il modo
 * in cui l'isteresi si verifica come *sequenza* — che è la forma in cui NFR9 è enunciato — invece
 * che come singola decisione.
 */

const HOOK_TIMEOUT_MS = 180_000;
const NOW = new Date('2026-05-04T09:00:00.000Z');

let harness: ApiHarness;

/** La coppia che il pannello di controllo mostra (DD §3.2), letta dalle due porte. */
async function control(): Promise<{ mode: string; strategy: StrategyName }> {
  const [mode, strategy] = await Promise.all([
    harness.mode.getMode(),
    harness.allocation.getActiveStrategy(),
  ]);
  return { mode, strategy };
}

/** Una sequenza di livelli osservati, nell'ordine. */
async function observe(...levels: readonly TrafficLevel[]): Promise<void> {
  for (const level of levels) await harness.mode.onTrafficLevel(level);
}

beforeAll(async () => {
  harness = await startApiHarness(NOW.toISOString());
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  await harness.reset();
  harness.clock.setNow(NOW);
});

describe('[R12][NFR9] Auto Mode: isteresi sui livelli di traffico', () => {
  it('parte da NearestAvailable, che è il default del sistema', async () => {
    expect(await control()).toEqual({ mode: 'AUTO', strategy: 'NEAREST_AVAILABLE' });
  });

  it('su Medium avvisa e non commuta, in nessuna delle due direzioni', async () => {
    await observe('MEDIUM');
    expect((await control()).strategy).toBe('NEAREST_AVAILABLE');

    // E nemmeno scendendo dall'alto: la banda morta è asimmetrica solo rispetto alle soglie, non
    // rispetto alla direzione da cui la si attraversa.
    await observe('HIGH', 'MEDIUM');
    expect((await control()).strategy).toBe('MINIMUM_ETA');
  });

  it('su High commuta a MinimumETA', async () => {
    await observe('HIGH');
    expect((await control()).strategy).toBe('MINIMUM_ETA');
  });

  it('torna a NearestAvailable solo quando il traffico rientra su Low', async () => {
    await observe('HIGH');
    await observe('MEDIUM');

    // Il punto di NFR9: Medium **non** riporta al default, o il sistema oscillerebbe a ogni
    // fluttuazione del traffico attorno alla soglia.
    expect((await control()).strategy).toBe('MINIMUM_ETA');

    await observe('LOW');
    expect((await control()).strategy).toBe('NEAREST_AVAILABLE');
  });

  it('il livello osservato viene persistito anche quando non provoca nessun cambio', async () => {
    await observe('MEDIUM');

    // È la decisione D20, ed è la premessa della D11: senza questa riga `enableAuto()` non
    // saprebbe che cosa rivalutare, e una replica che non ha gestito la lettura nemmeno.
    const [record] = await harness.persistence.find('system_mode', { limit: 1 });
    expect(record?.lastTrafficLevel).toBe('MEDIUM');
  });
});

describe('[R13][NFR10] Manual Mode: la precedenza dell intervento umano', () => {
  it('la scelta manuale porta in Manual nella stessa scrittura della strategia', async () => {
    await harness.mode.setManual('MINIMUM_ETA');

    // Un solo record, quindi non esiste interleaving che lasci i due valori in disaccordo: è la
    // forma in cui NFR10 chiede la transizione «immediate and atomic».
    expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'MINIMUM_ETA' });
  });

  it('in Manual nessun livello di traffico cambia la strategia attiva', async () => {
    await harness.mode.setManual('NEAREST_AVAILABLE');

    // **Tutti** i livelli, non solo quello che commuterebbe: NFR10 dice «no traffic level
    // whatsoever».
    await observe('HIGH', 'MEDIUM', 'LOW', 'HIGH');

    expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });
  });

  it('un cambio automatico deciso mentre si passa in Manual non sovrascrive la scelta umana', async () => {
    /**
     * La corsa fra i due scrittori, costruita a mano.
     *
     * Il `ModeController` legge il record — modo Auto, strategia di default — e decide di
     * commutare. Prima che scriva, l'operatore sceglie a mano. Senza la condizione sulla
     * scrittura, il cambio automatico atterrerebbe dopo e disferebbe la scelta dell'operatore,
     * che è precisamente il modo in cui il DD §4.3 falsifica NFR10.
     *
     * `setActiveStrategy(name, 'auto')` scrive condizionatamente al modo Auto, quindi qui non
     * atterra: `applySwitch()` assorbe lo `StaleRecordError` e non commuta.
     */
    const automatico = harness.mode.onTrafficLevel('HIGH');
    await harness.mode.setManual('NEAREST_AVAILABLE');
    await automatico;

    expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });
  });
});

describe('[R13][R12] Il rientro in Auto rivaluta subito il traffico', () => {
  it('applica la strategia che compete all ultimo livello noto', async () => {
    await observe('HIGH');
    await harness.mode.setManual('NEAREST_AVAILABLE');
    expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });

    await harness.mode.enableAuto();

    // Decisione D11: senza la rivalutazione il sistema resterebbe sulla scelta manuale
    // dichiarandosi automatico, e R12 sarebbe violato per un tempo che nessuno può limitare.
    expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
  });

  it('su Medium tiene la strategia attiva in quell istante', async () => {
    await observe('MEDIUM');
    await harness.mode.setManual('MINIMUM_ETA');

    await harness.mode.enableAuto();

    // RASD R13: «should the level be Medium […] the strategy active at that instant is kept».
    // La banda morta non commuta, nemmeno al rientro.
    expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
  });

  it('senza nessuna lettura di traffico non c è niente da rivalutare', async () => {
    await harness.mode.setManual('MINIMUM_ETA');

    await harness.mode.enableAuto();

    expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
  });

  it('è idempotente: chiamarla in modo Auto non rompe nulla', async () => {
    await observe('HIGH');

    await harness.mode.enableAuto();
    await harness.mode.enableAuto();

    expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
  });
});

describe('[R12][R13] Che cosa vede l operatore sul pannello di controllo', () => {
  it('su Medium riceve un alert che suggerisce MinimumETA, e nessun cambio', async () => {
    const dashboard = recordOperator(harness.notificationSessions);

    await observe('MEDIUM');

    // R12: «the system alerts the Fleet Operator, suggesting a switch to the Minimum ETA
    // strategy». L'alert è l'unica cosa osservabile che accade su Medium, ed è ciò che distingue
    // «ho letto il traffico e non commuto» da «non ho letto niente».
    expect(dashboard.received).toHaveLength(1);
    expect(dashboard.received[0]).toMatchObject({
      trafficLevel: 'MEDIUM',
      strategy: 'MINIMUM_ETA',
    });
    expect((await control()).strategy).toBe('NEAREST_AVAILABLE');
  });

  it('l alert non si ripete finché il livello resta lo stesso', async () => {
    const dashboard = recordOperator(harness.notificationSessions);

    await observe('MEDIUM', 'MEDIUM', 'MEDIUM');

    // R12 parla di traffico che «reach»es la soglia: è un passaggio, non uno stato. Ripeterlo a
    // ogni lettura riempirebbe il pannello della stessa riga per tutta la durata della condizione.
    expect(dashboard.received).toHaveLength(1);
  });

  it('un cambio automatico viene annunciato con il livello che lo ha provocato', async () => {
    const dashboard = recordOperator(harness.notificationSessions);

    await observe('HIGH');

    expect(dashboard.received).toHaveLength(1);
    expect(dashboard.received[0]).toMatchObject({
      strategy: 'MINIMUM_ETA',
      mode: 'AUTO',
      trafficLevel: 'HIGH',
    });
  });

  it('la scelta manuale annuncia strategia e modo insieme', async () => {
    const dashboard = recordOperator(harness.notificationSessions);

    await harness.mode.setManual('MINIMUM_ETA');

    // È l'`ManualOverrideEvent` della Figura 2.6: le altre dashboard connesse devono sapere che
    // il sistema non è più automatico, o mostrerebbero un modo che non è quello vero.
    expect(dashboard.received[0]).toMatchObject({ strategy: 'MINIMUM_ETA', mode: 'MANUAL' });
  });

  it('nessuno di questi eventi lascia una riga nello storico delle notifiche', async () => {
    await observe('MEDIUM', 'HIGH');
    await harness.mode.setManual('NEAREST_AVAILABLE');

    // La `Notification` del RASD §2.2.3 è indirizzata a un **passeggero**, e questi eventi non ne
    // hanno uno: riguardano chi sorveglia la flotta. Scriverli in tabella avrebbe richiesto un
    // destinatario inventato.
    expect(await harness.countRows('notification')).toBe(0);
  });
});

describe('[R12] TrafficMonitor: la lettura periodica entra nel dominio', () => {
  it('legge il livello dai servizi esterni e lo passa al controller', async () => {
    // Le 17:00 UTC sono le 19:00 a Milano: ora di punta, quindi traffico alto.
    harness.clock.setNow(new Date('2026-05-04T17:00:00.000Z'));

    await harness.trafficMonitor.runOnce();

    // Nessun timer è partito: `ModeModule` si compone senza `ScheduleModule`, e la lettura è
    // avvenuta perché il test l'ha chiesta (CLAUDE.md Regola 3).
    expect(await control()).toEqual({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
  });

  it('una lettura in ora tranquilla riporta il sistema al default', async () => {
    harness.clock.setNow(new Date('2026-05-04T17:00:00.000Z'));
    await harness.trafficMonitor.runOnce();
    expect((await control()).strategy).toBe('MINIMUM_ETA');

    // Le 01:00 UTC sono le 03:00 a Milano: traffico basso.
    harness.clock.setNow(new Date('2026-05-05T01:00:00.000Z'));
    await harness.trafficMonitor.runOnce();

    expect((await control()).strategy).toBe('NEAREST_AVAILABLE');
  });
});
