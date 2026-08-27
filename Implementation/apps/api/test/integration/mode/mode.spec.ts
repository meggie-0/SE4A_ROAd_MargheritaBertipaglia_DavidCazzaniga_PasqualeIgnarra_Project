import type { StrategyName, TrafficLevel } from '@road/shared';

import { StaleRecordError } from '../../../src/persistence/persistence.port';
import { recordOperator, recordPassenger } from '../../support/notifications';
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

/**
 * Un passeggero qualsiasi, per il caso che verifica che gli eventi di modo **non** lo raggiungano.
 *
 * Non serve registrarlo davvero: il filtro della sessione confronta l'identificatore con il
 * destinatario dell'evento, e nessuno di questi eventi ne ha uno. Un utente vero renderebbe il
 * caso più lento senza renderlo più severo.
 */
const PASSEGGERO_ID = '00000000-0000-4000-8000-000000000001';

let harness: ApiHarness;

/** La coppia che il pannello di controllo mostra (DD §3.2), letta dalle due porte. */
async function control(): Promise<{ mode: string; strategy: StrategyName }> {
  const [reading, strategy] = await Promise.all([
    harness.mode.getMode(),
    harness.allocation.getActiveStrategy(),
  ]);
  return { mode: reading.mode, strategy };
}

/** L'ultimo livello di traffico noto, che `getMode()` restituisce col modo (decisione D75). */
async function trafficLevel(): Promise<TrafficLevel | null> {
  return (await harness.mode.getMode()).lastTrafficLevel;
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

/**
 * La **via di lettura** del livello di traffico (RASD §2.3, decisione D75).
 *
 * Il caso di sopra verifica che il livello venga *scritto*, interrogando la persistenza. Questi
 * verificano che si possa *leggere* dal dominio, che è la cosa che mancava: il valore era nel
 * record e nessuna operazione lo restituiva, quindi la dashboard che il RASD §2.3 descrive — «a
 * clear overview of traffic levels» — non aveva modo di mostrarlo.
 */
describe('[R12] Il livello di traffico è leggibile insieme al modo', () => {
  it('è nullo finché nessuna osservazione è arrivata', async () => {
    // Non è `LOW`. Un sistema appena avviato non ha ancora interrogato il servizio di mappe, e i
    // due casi vanno distinti: è la stessa distinzione su cui si regge la decisione D11, che non
    // rivaluta nulla quando il livello è nullo.
    expect(await trafficLevel()).toBeNull();
  });

  it('restituisce l ultimo livello osservato', async () => {
    await observe('LOW', 'HIGH');
    expect(await trafficLevel()).toBe('HIGH');
  });

  it('esce dalla stessa lettura del modo, quindi i due valori non possono disallinearsi', async () => {
    await observe('HIGH');

    const reading = await harness.mode.getMode();
    expect(reading).toEqual({ mode: 'AUTO', lastTrafficLevel: 'HIGH' });
  });

  it('resta leggibile in modo Manual, dove può non corrispondere alla strategia attiva', async () => {
    await harness.mode.setManual('NEAREST_AVAILABLE');
    await observe('HIGH');

    /**
     * Il caso che rende l'indicatore utile invece che decorativo.
     *
     * In Manual le letture continuano a registrarsi (decisione D20) ma non commutano niente (R13),
     * quindi il sistema alloca col veicolo più vicino mentre il traffico è intenso. È esattamente
     * la situazione in cui l'operatore deve poter vedere il livello per decidere se il suo
     * intervento ha ancora senso — e senza questa lettura non potrebbe.
     */
    expect(await harness.mode.getMode()).toEqual({ mode: 'MANUAL', lastTrafficLevel: 'HIGH' });
    expect((await control()).strategy).toBe('NEAREST_AVAILABLE');
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

  it('un cambio automatico non può atterrare dopo che il modo è passato a Manual', async () => {
    /**
     * La corsa fra i due scrittori, **senza dipendere dalla tempistica**.
     *
     * Lo scenario da falsificare è questo: il `ModeController` legge il record — modo Auto — e
     * decide di commutare; prima che la scrittura arrivi al database, l'operatore sceglie a mano;
     * il cambio automatico atterra dopo e disfa la scelta dell'essere umano. È precisamente il modo
     * in cui il DD §4.3 falsifica NFR10.
     *
     * Costruirlo lasciando interlacciare due promesse funzionerebbe, ma l'esito dipenderebbe da
     * quale delle due andate e ritorni verso il database finisce prima. Qui invece si esegue
     * l'ultimo passo *a mano*, nell'ordine peggiore possibile: prima la scelta manuale, poi la
     * scrittura automatica che il controller avrebbe fatto. La scrittura è condizionata al modo
     * Auto, quindi non avviene e solleva — che è l'unica cosa che il test deve dimostrare.
     */
    await harness.mode.setManual('NEAREST_AVAILABLE');

    await expect(
      harness.allocation.setActiveStrategy('MINIMUM_ETA', 'auto'),
    ).rejects.toBeInstanceOf(StaleRecordError);

    expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });
  });

  it('e il controller assorbe quel rifiuto invece di far fallire la lettura periodica', async () => {
    await harness.mode.setManual('NEAREST_AVAILABLE');

    // Un'esecuzione periodica non ha nessuno a cui riferire un errore: se `applySwitch()`
    // propagasse lo `StaleRecordError`, una decisione umana perfettamente legittima farebbe
    // fallire il `TrafficMonitor` e lo scheduler lo registrerebbe come guasto.
    await expect(harness.mode.onTrafficLevel('HIGH')).resolves.toBeUndefined();

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

  it('rivaluta il traffico letto **durante** il modo Manual, non quello di prima', async () => {
    /**
     * La decisione D20 messa alla prova: le letture di traffico che avvengono in modo Manual
     * lasciano traccia, pur non provocando nessun cambio.
     *
     * È la premessa della D11. Se `onTrafficLevel()` uscisse subito quando il modo è Manual senza
     * scrivere `lastTrafficLevel`, `enableAuto()` rivaluterebbe il livello di *prima* della scelta
     * manuale — qui `LOW` — e il sistema resterebbe su `NearestAvailable` mentre il traffico è alto
     * da un pezzo. Nessuna delle altre asserzioni di questo file se ne accorgerebbe.
     */
    await observe('LOW');
    await harness.mode.setManual('NEAREST_AVAILABLE');

    await observe('HIGH');
    expect(await control()).toEqual({ mode: 'MANUAL', strategy: 'NEAREST_AVAILABLE' });

    await harness.mode.enableAuto();

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

  it('il rientro in Auto senza commutazione non annuncia una commutazione', async () => {
    await observe('MEDIUM');
    await harness.mode.setManual('MINIMUM_ETA');
    const dashboard = recordOperator(harness.notificationSessions);

    await harness.mode.enableAuto();

    /**
     * Su `MEDIUM` la banda morta prescrive di **tenere** la strategia attiva (RASD R13), quindi qui
     * non c'è nessuno switch da annunciare — ma il modo è cambiato, e le dashboard già connesse
     * devono saperlo o continuerebbero a mostrare `MANUAL` per un sistema automatico.
     *
     * Il messaggio è la parte che conta: dire «strategia commutata automaticamente» dove nulla è
     * stato commutato metterebbe una notizia falsa nel pannello che il DD §3.2 dedica proprio agli
     * switch automatici.
     */
    expect(dashboard.received).toHaveLength(1);
    expect(dashboard.received[0]).toMatchObject({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
    expect(dashboard.received[0]?.message).toContain('resta attiva');
    expect(dashboard.received[0]?.message).not.toContain('commutata');
  });

  it('il rientro in Auto che commuta annuncia la commutazione, e una volta sola', async () => {
    await observe('HIGH');
    await harness.mode.setManual('NEAREST_AVAILABLE');
    const dashboard = recordOperator(harness.notificationSessions);

    await harness.mode.enableAuto();

    // Qui la strategia cambia davvero, quindi il messaggio della commutazione è vero. Un solo
    // evento: annunciare anche il cambio di modo raddoppierebbe la riga per un fatto solo.
    expect(dashboard.received).toHaveLength(1);
    expect(dashboard.received[0]).toMatchObject({ mode: 'AUTO', strategy: 'MINIMUM_ETA' });
    expect(dashboard.received[0]?.message).toContain('commutata');
  });

  it('nessuno di questi eventi raggiunge un passeggero', async () => {
    const passeggero = recordPassenger(harness.notificationSessions, PASSEGGERO_ID);
    const dashboard = recordOperator(harness.notificationSessions);

    await observe('MEDIUM', 'HIGH');
    await harness.mode.setManual('NEAREST_AVAILABLE');
    await harness.mode.enableAuto();

    /**
     * L'instradamento verso l'operatore è scritto per **esclusione** — gli arriva tutto ciò che non
     * è un evento di corsa — e una regola negata non protegge da sola: il giorno in cui nascesse un
     * evento con una categoria del RASD e senza passeggero, la consegna sbagliata non farebbe
     * fallire niente. Questo caso è il contrappeso, e verifica il criterio di M5 («nessun evento
     * relativo a corse altrui») sugli eventi nati in M6.
     */
    expect(passeggero.received).toEqual([]);
    expect(dashboard.received.length).toBeGreaterThan(0);
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
