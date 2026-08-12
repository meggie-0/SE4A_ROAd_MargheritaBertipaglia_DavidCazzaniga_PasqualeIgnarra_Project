import { recordOperator } from '../../support/notifications';
import { startApiHarness, type ApiHarness } from '../../support/postgres';

/**
 * `RebalancingManager`: analisi della domanda e riposizionamento proattivo (M6, RASD R10, R11, G9).
 *
 * Gira su **Postgres vero**: serve Docker in esecuzione. La ragione non è il database in sé, sono
 * le due letture che il manager fa e che nessun doppio riprodurrebbe fedelmente: la fascia oraria
 * settimanale di `demand_sample`, cercata in **ora locale di Milano**, e gli eventi attivi in un
 * istante, che è un confronto su un intervallo semiaperto scritto in SQL.
 *
 * Il dataset è costruito caso per caso invece di usare il seed: il seed cambia quando cambiano i
 * profili di domanda, e un test che ci si appoggiasse diventerebbe rosso per una modifica che non
 * riguarda ciò che sta verificando.
 *
 * **L'istante di riferimento.** Lunedì 4 maggio 2026, 19:30 UTC, che a Milano sono le **21:30**
 * (ora legale). La fascia settimanale è quindi `dayOfWeek = 1`, `hourOfDay = 21`: se il manager
 * cercasse la fascia in UTC cercherebbe le 19, non troverebbe nessun campione e ogni zona
 * risulterebbe a domanda zero — che è precisamente il difetto contro cui MILESTONES.md §M6 mette
 * in guardia.
 */

const NOW = new Date('2026-05-04T19:30:00.000Z');
const MILAN_SLOT = { dayOfWeek: 1, hourOfDay: 21 };
const HOOK_TIMEOUT_MS = 180_000;

/** Tre zone reali, abbastanza lontane fra loro perché l'appartenenza non sia mai in dubbio. */
const DUOMO = { id: 'duomo', name: 'Duomo / Centro', lat: 45.4642, lon: 9.19 };
const SAN_SIRO = { id: 'san-siro', name: 'San Siro', lat: 45.4781, lon: 9.124 };
const NAVIGLI = { id: 'navigli', name: 'Navigli / Darsena', lat: 45.45, lon: 9.175 };

let harness: ApiHarness;

async function givenZones(): Promise<void> {
  for (const zone of [DUOMO, SAN_SIRO, NAVIGLI]) await harness.persistence.create('zone', zone);
}

/** La domanda di base di una zona nella fascia oraria di questo test. */
async function givenBaseDemand(zoneId: string, baseDemand: number): Promise<void> {
  await harness.persistence.create('demand_sample', { zoneId, ...MILAN_SLOT, baseDemand });
}

/** Un evento che moltiplica la domanda di una zona nella finestra indicata. */
async function givenEvent(
  zoneId: string,
  name: string,
  multiplier: number,
  window: { readonly startsAt: string; readonly endsAt: string },
): Promise<void> {
  await harness.persistence.create('demand_event', {
    zoneId,
    name,
    multiplier,
    startsAt: new Date(window.startsAt),
    endsAt: new Date(window.endsAt),
  });
}

/**
 * Un veicolo inattivo nel centro, spostato di `lonOffset` gradi in longitudine.
 *
 * Tutti restano ben dentro la cella di Voronoi del Duomo — San Siro è a 5 km a ovest, i Navigli a
 * 1,8 km a sud — quindi ciò che l'offset cambia è solo *quale* di loro è il più vicino alla zona di
 * destinazione, che è la regola su cui `rebalance()` sceglie.
 */
async function givenIdleRobotaxi(id: string, lonOffset: number): Promise<void> {
  await harness.persistence.create('robotaxi', {
    id,
    state: 'AVAILABLE',
    lat: DUOMO.lat,
    lon: DUOMO.lon + lonOffset,
    zoneId: DUOMO.id,
  });
}

/** Lo stato persistito di un veicolo. */
async function stateOf(id: string): Promise<string | undefined> {
  const [record] = await harness.persistence.find('robotaxi', { where: { id }, limit: 1 });
  return record?.state;
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
  await givenZones();
});

describe('[R10][G9] Demand Analysis su un dataset noto', () => {
  it('senza eventi attivi le zone escono nell ordine della domanda di base', async () => {
    await givenBaseDemand(DUOMO.id, 9);
    await givenBaseDemand(NAVIGLI.id, 13);
    await givenBaseDemand(SAN_SIRO.id, 3);

    const { zones, analyzedAt } = await harness.rebalancing.analyzeDemand();

    expect(zones.map((zone) => zone.zoneId)).toEqual(['navigli', 'duomo', 'san-siro']);
    // L'istante viene dal dominio, non da chi chiama: è `ClockPort`, mai l'orologio di sistema.
    expect(analyzedAt).toEqual(NOW);
  });

  it('una partita a San Siro la porta in cima (decisione D12)', async () => {
    await givenBaseDemand(DUOMO.id, 9);
    await givenBaseDemand(NAVIGLI.id, 13);
    await givenBaseDemand(SAN_SIRO.id, 3);
    await givenEvent(SAN_SIRO.id, 'Partita di campionato', 8, {
      startsAt: '2026-05-04T18:00:00.000Z',
      endsAt: '2026-05-04T22:00:00.000Z',
    });

    const { zones } = await harness.rebalancing.analyzeDemand();

    // 3 × 8 = 24, davanti ai 13 dei Navigli: è il modello a due livelli che rende utile
    // `demand_event`, e senza il quale una zona per eventi resterebbe sempre in fondo.
    expect(zones.map((zone) => zone.zoneId)).toEqual(['san-siro', 'navigli', 'duomo']);
    expect(zones[0]).toMatchObject({
      zoneId: 'san-siro',
      baseDemand: 3,
      expectedDemand: 24,
      activeEvents: ['Partita di campionato'],
    });
  });

  it('un evento finito non conta più: la finestra è semiaperta', async () => {
    await givenBaseDemand(SAN_SIRO.id, 3);
    await givenBaseDemand(NAVIGLI.id, 13);
    // L'evento finisce **nell'istante** dell'analisi: `t ∈ [inizio, fine)` lo esclude.
    await givenEvent(SAN_SIRO.id, 'Partita finita', 8, {
      startsAt: '2026-05-04T17:00:00.000Z',
      endsAt: '2026-05-04T19:30:00.000Z',
    });

    const { zones } = await harness.rebalancing.analyzeDemand();

    expect(zones.map((zone) => zone.zoneId)).toEqual(['navigli', 'san-siro', 'duomo']);
    expect(zones.find((zone) => zone.zoneId === 'san-siro')?.expectedDemand).toBe(3);
  });

  it('cerca la fascia in ora locale di Milano e non in UTC', async () => {
    // Il campione esiste **solo** per le 21 locali. Se il manager cercasse le 19 — l'ora UTC di
    // questo istante — non troverebbe nulla e la zona uscirebbe a domanda zero.
    await givenBaseDemand(DUOMO.id, 11);

    const { zones } = await harness.rebalancing.analyzeDemand();

    expect(zones.find((zone) => zone.zoneId === 'duomo')?.baseDemand).toBe(11);
  });

  it('una zona senza campione in questa fascia vale zero, e resta nell elenco', async () => {
    await givenBaseDemand(DUOMO.id, 5);

    const { zones } = await harness.rebalancing.analyzeDemand();

    // Tutte e tre le zone compaiono: escluderne una l'avrebbe resa irraggiungibile dal
    // riposizionamento, perché una zona fuori dall'ordinamento non riceve mai un veicolo.
    expect(zones).toHaveLength(3);
    expect(zones.map((zone) => zone.expectedDemand)).toEqual([5, 0, 0]);
    // Pareggio a zero rotto sull'identificatore crescente: `navigli` prima di `san-siro`.
    expect(zones.map((zone) => zone.zoneId)).toEqual(['duomo', 'navigli', 'san-siro']);
  });

  it('conta i veicoli inattivi per zona e ne ricava il deficit', async () => {
    await givenBaseDemand(DUOMO.id, 1);
    await givenIdleRobotaxi('RT-01', 0);
    await givenIdleRobotaxi('RT-02', 0.005);

    const { zones } = await harness.rebalancing.analyzeDemand();
    const duomo = zones.find((zone) => zone.zoneId === 'duomo');

    expect(duomo).toMatchObject({ availableRobotaxis: 2, expectedDemand: 1, deficit: -1 });
  });
});

describe('[R11][G9] Proactive Fleet Rebalancing', () => {
  /**
   * Lo scenario condiviso dai casi che seguono.
   *
   * - `san-siro`: base 0,5 con una partita ×8 → domanda attesa 4, nessun veicolo → deficit +4;
   * - `navigli`: base 2, nessun veicolo → deficit +2;
   * - `duomo`: base 1 con tre veicoli fermi → deficit −2, e due veicoli da cedere.
   *
   * I tre veicoli stanno tutti nel centro ma a longitudini diverse: `RT-03` è il più a ovest,
   * quindi il più vicino a San Siro; fra i due rimasti `RT-01` è il più vicino ai Navigli.
   */
  async function givenUnbalancedCity(): Promise<void> {
    await givenBaseDemand(SAN_SIRO.id, 0.5);
    await givenBaseDemand(NAVIGLI.id, 2);
    await givenBaseDemand(DUOMO.id, 1);
    await givenEvent(SAN_SIRO.id, 'Partita di campionato', 8, {
      startsAt: '2026-05-04T18:00:00.000Z',
      endsAt: '2026-05-04T22:00:00.000Z',
    });
    await givenIdleRobotaxi('RT-01', 0);
    await givenIdleRobotaxi('RT-02', 0.005);
    await givenIdleRobotaxi('RT-03', -0.005);
  }

  it('manda i veicoli alle zone in deficit, dalla più scoperta', async () => {
    await givenUnbalancedCity();

    const plan = await harness.rebalancing.rebalance();

    // L'ordine è quello del deficit — San Siro (+4) prima dei Navigli (+2) — e non quello della
    // domanda attesa, che qui coincide ma in generale no (decisione D12).
    expect(plan.dispatched).toEqual([
      { robotaxiId: 'RT-03', targetZoneId: 'san-siro', fromZoneId: 'duomo' },
      { robotaxiId: 'RT-01', targetZoneId: 'navigli', fromZoneId: 'duomo' },
    ]);
  });

  it('i veicoli mandati passano a REBALANCING, gli altri restano disponibili', async () => {
    await givenUnbalancedCity();

    await harness.rebalancing.rebalance();

    expect(await stateOf('RT-03')).toBe('REBALANCING');
    expect(await stateOf('RT-01')).toBe('REBALANCING');
    // `RT-02` resta al Duomo: la zona ne cede due e non tre, perché deve coprire la propria
    // domanda attesa. Svuotarla per riempire le altre sarebbe lo scambio che il riposizionamento
    // dovrebbe evitare.
    expect(await stateOf('RT-02')).toBe('AVAILABLE');
  });

  it('ogni veicolo mandato lascia una riga in rebalancing_action', async () => {
    await givenUnbalancedCity();

    await harness.rebalancing.rebalance();

    const actions = await harness.persistence.find('rebalancing_action', {
      orderBy: [{ field: 'robotaxiId' }],
    });

    // La destinazione non è una colonna di `robotaxi` e non passa da `requestRebalancing()`:
    // senza questa riga, *dove* un veicolo stia andando non sarebbe scritto da nessuna parte.
    expect(actions.map((action) => [action.robotaxiId, action.targetZoneId])).toEqual([
      ['RT-01', 'navigli'],
      ['RT-03', 'san-siro'],
    ]);
    expect(actions.every((action) => action.status === 'TRIGGERED')).toBe(true);
    expect(actions.every((action) => action.createdAt.getTime() === NOW.getTime())).toBe(true);
  });

  it('l operatore riceve un alert per ciascun veicolo, con la zona di destinazione', async () => {
    await givenUnbalancedCity();
    const dashboard = recordOperator(harness.notificationSessions);

    await harness.rebalancing.rebalance();

    // Due eventi per veicolo: la transizione di stato, che il `Robotaxi` notifica per conto suo
    // (decisione D39), e l'alert del riposizionamento, che porta la destinazione.
    const alerts = dashboard.received.filter((one) => one.zoneId !== null);
    expect(alerts.map((one) => [one.robotaxiId, one.zoneId])).toEqual([
      ['RT-03', 'san-siro'],
      ['RT-01', 'navigli'],
    ]);
    expect(alerts[0]?.message).toContain('San Siro');
    // La dashboard vede anche i veicoli passare a `REBALANCING`, come per ogni altro movimento.
    expect(dashboard.robotaxiStates()).toEqual(['REBALANCING', 'REBALANCING']);
  });

  it('a parità di distanza vince il robotaxi con l identificatore minore', async () => {
    await givenBaseDemand(SAN_SIRO.id, 4);
    await givenBaseDemand(DUOMO.id, 0);
    // Due veicoli **equidistanti** da San Siro: simmetrici rispetto alla latitudine del Duomo.
    await givenIdleRobotaxi('RT-09', 0);
    await harness.persistence.create('robotaxi', {
      id: 'RT-02',
      state: 'AVAILABLE',
      lat: DUOMO.lat,
      lon: DUOMO.lon,
      zoneId: DUOMO.id,
    });

    const plan = await harness.rebalancing.rebalance();

    // Senza questa regola l'esito dipenderebbe dall'ordine con cui il database ha restituito le
    // righe, e il test fallirebbe una volta ogni tanto senza che nulla sia rotto.
    expect(plan.dispatched.map((one) => one.robotaxiId)).toEqual(['RT-02']);
  });

  it('un veicolo che non è inattivo non viene mai scelto', async () => {
    await givenBaseDemand(SAN_SIRO.id, 4);
    await givenBaseDemand(DUOMO.id, 0);
    await givenIdleRobotaxi('RT-01', 0);
    await harness.persistence.create('robotaxi', {
      id: 'RT-02',
      state: 'MAINTENANCE',
      lat: DUOMO.lat,
      lon: DUOMO.lon - 0.01,
      zoneId: DUOMO.id,
    });

    const plan = await harness.rebalancing.rebalance();

    // `RT-02` è più vicino a San Siro ma è in officina: `getAvailableRobotaxis()` non lo
    // restituisce, quindi non entra nemmeno nella scelta (R9).
    expect(plan.dispatched.map((one) => one.robotaxiId)).toEqual(['RT-01']);
    expect(await stateOf('RT-02')).toBe('MAINTENANCE');
  });

  it('senza zone in deficit non muove nulla', async () => {
    await givenBaseDemand(DUOMO.id, 0);
    await givenIdleRobotaxi('RT-01', 0);

    const plan = await harness.rebalancing.rebalance();

    // Il ramo «no rebalancing needed» della Figura 2.7: la distribuzione resta quella che è.
    expect(plan.dispatched).toEqual([]);
    expect(await stateOf('RT-01')).toBe('AVAILABLE');
    expect(await harness.countRows('rebalancing_action')).toBe(0);
  });

  it('senza veicoli da cedere non muove nulla, per quanto grande sia il deficit', async () => {
    await givenBaseDemand(SAN_SIRO.id, 50);
    // L'unico veicolo sta in una zona che ha bisogno di sé: la sua domanda attesa lo impegna.
    await givenBaseDemand(DUOMO.id, 3);
    await givenIdleRobotaxi('RT-01', 0);

    const plan = await harness.rebalancing.rebalance();

    expect(plan.dispatched).toEqual([]);
    expect(await stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('è deterministico: due cicli sullo stesso stato scelgono gli stessi veicoli', async () => {
    await givenUnbalancedCity();

    const first = await harness.rebalancing.rebalance();

    // Si riporta la città allo stato di partenza e si ripete: l'esito dev'essere identico, o
    // nessun test su questo componente sarebbe stabile.
    await harness.reset();
    await givenZones();
    await givenUnbalancedCity();
    const second = await harness.rebalancing.rebalance();

    expect(second.dispatched).toEqual(first.dispatched);
  });
});
