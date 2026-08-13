import { FLEET_POSITION_REFRESH_MS, haversineKm, type GeoPoint } from '@road/shared';

import {
  DEFAULT_SIMULATOR_SETTINGS,
  SIMULATED_TIME_SCALE,
  FleetSimulator,
  ticksToCover,
  type FleetSimulatorSettings,
} from '../src/index';

/**
 * Il simulatore di flotta (M7): un mondo che si muove **solo** quando qualcuno chiama `tick()`.
 *
 * Questi test costruiscono la classe direttamente, e non attraverso una porta: `@road/simulator` è
 * un pacchetto, non un modulo dell'API, e la regola di CLAUDE.md sui confini riguarda i moduli
 * sotto `apps/api/src/`. Ciò che passa dalla porta è l'*uso* del simulatore, verificato nei test di
 * `external` e nel cancello di M7; qui si verifica la fisica, cioè l'unica cosa che questo
 * pacchetto promette.
 *
 * Non c'è un orologio da nessuna parte, ed è il punto: il tempo del simulatore è il numero di tick
 * ricevuti, quindi «quanto ci mette» è una divisione e non un'attesa.
 */

const DUOMO: GeoPoint = { lat: 45.4642, lon: 9.19 };
const CADORNA: GeoPoint = { lat: 45.468, lon: 9.175 };
const GARIBALDI: GeoPoint = { lat: 45.4847, lon: 9.1874 };

/** Un passo tondo: 20 km/h per 180 secondi fa esattamente un chilometro a tick. */
const ONE_KM_PER_TICK: FleetSimulatorSettings = { speedKmH: 20, tickSeconds: 180 };

describe('[NFR8] Il simulatore di flotta avanza solo su tick espliciti', () => {
  it('un veicolo di cui non si sa nulla non compare nella telemetria', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);

    expect(simulator.telemetry()).toEqual([]);
    expect(simulator.reading('RT-01')).toBeNull();
  });

  it('un veicolo senza tick non si muove, per quanto lunga sia la rotta', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-01', DUOMO, [GARIBALDI]);

    expect(simulator.reading('RT-01')?.position).toEqual(DUOMO);
    expect(simulator.reading('RT-01')?.hasArrived).toBe(false);
  });

  it('arriva a destinazione in un numero di tick che si può calcolare prima', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-01', DUOMO, [GARIBALDI]);

    const expected = ticksToCover(haversineKm(DUOMO, GARIBALDI), ONE_KM_PER_TICK);

    // Un tick prima dell'ultimo il veicolo è ancora in strada: senza questa asserzione, un
    // simulatore che teletrasporta i veicoli al primo tick passerebbe quella dopo.
    for (let step = 0; step < expected - 1; step += 1) simulator.tick();
    expect(simulator.reading('RT-01')?.hasArrived).toBe(false);

    simulator.tick();
    expect(simulator.reading('RT-01')?.hasArrived).toBe(true);
    expect(simulator.reading('RT-01')?.position).toEqual(GARIBALDI);
    expect(simulator.reading('RT-01')?.remainingKm).toBe(0);
  });

  it('percorre la polyline punto per punto, senza tagliare', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-01', DUOMO, [CADORNA, GARIBALDI]);

    const viaCadorna = haversineKm(DUOMO, CADORNA) + haversineKm(CADORNA, GARIBALDI);
    const direct = haversineKm(DUOMO, GARIBALDI);
    // La rotta passa da Cadorna, che è più lunga della linea d'aria: se il simulatore tagliasse,
    // arriverebbe prima.
    expect(viaCadorna).toBeGreaterThan(direct);

    const ticks = ticksToCover(viaCadorna, ONE_KM_PER_TICK);
    for (let step = 0; step < ticks - 1; step += 1) simulator.tick();
    expect(simulator.reading('RT-01')?.hasArrived).toBe(false);

    simulator.tick();
    expect(simulator.reading('RT-01')?.hasArrived).toBe(true);
  });

  it('la strada che manca diminuisce a ogni tick', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-01', DUOMO, [GARIBALDI]);

    let previous = simulator.reading('RT-01')?.remainingKm ?? 0;
    expect(previous).toBeGreaterThan(0);

    for (let step = 0; step < 2; step += 1) {
      simulator.tick();
      const current = simulator.reading('RT-01')?.remainingKm ?? 0;
      expect(current).toBeLessThan(previous);
      previous = current;
    }
  });

  it('una rotta revocata ferma il veicolo dove si trova, e non lo dichiara arrivato', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-01', DUOMO, [GARIBALDI]);
    simulator.tick();

    const whereItStopped = simulator.reading('RT-01')?.position;
    simulator.revokeRoute('RT-01');

    const reading = simulator.reading('RT-01');
    expect(reading?.position).toEqual(whereItStopped);
    expect(reading?.destination).toBeNull();
    expect(reading?.hasArrived).toBe(false);
    expect(reading?.remainingKm).toBe(0);

    // E da lì non si muove più: la revoca è ciò su cui l'annullamento di R14 conta.
    simulator.tick();
    expect(simulator.reading('RT-01')?.position).toEqual(whereItStopped);
  });

  it('revocare la rotta a un veicolo sconosciuto non è un errore', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);

    expect(() => simulator.revokeRoute('RT-99')).not.toThrow();
    expect(simulator.telemetry()).toEqual([]);
  });

  it('una nuova rotta riparte da dove il veicolo è arrivato, non da dove era partito', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-01', DUOMO, [GARIBALDI]);
    simulator.tick();

    const afterFirstLeg = simulator.reading('RT-01')?.position as GeoPoint;
    expect(afterFirstLeg).not.toEqual(DUOMO);

    // La posizione passata è quella che il chiamante ha in tabella, e può essere vecchia: il
    // simulatore è l'unico a sapere dove il veicolo si è spostato nel frattempo.
    simulator.followRoute('RT-01', DUOMO, [CADORNA]);
    expect(simulator.reading('RT-01')?.position).toEqual(afterFirstLeg);
  });

  it('una rotta che finisce dove il veicolo già si trova è arrivata subito', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-01', DUOMO, []);

    expect(simulator.reading('RT-01')?.hasArrived).toBe(true);
  });

  it('la telemetria esce in ordine di identificatore, sempre', () => {
    const simulator = new FleetSimulator(ONE_KM_PER_TICK);
    simulator.followRoute('RT-09', DUOMO, [GARIBALDI]);
    simulator.followRoute('RT-02', CADORNA, [GARIBALDI]);
    simulator.followRoute('RT-11', GARIBALDI, [DUOMO]);

    expect(simulator.telemetry().map((reading) => reading.robotaxiId)).toEqual([
      'RT-02',
      'RT-09',
      'RT-11',
    ]);
  });

  it('con i parametri di default un tick vale tre secondi a velocità urbana', () => {
    const simulator = new FleetSimulator();
    simulator.followRoute('RT-01', DUOMO, [GARIBALDI]);

    const expected = ticksToCover(haversineKm(DUOMO, GARIBALDI), DEFAULT_SIMULATOR_SETTINGS);
    for (let step = 0; step < expected; step += 1) simulator.tick();

    expect(simulator.reading('RT-01')?.hasArrived).toBe(true);
  });

  it('con i parametri di default un secondo di tempo reale vale sei secondi di mondo', () => {
    /*
     * L'invariante che tiene insieme le cadenze, verificata **percorrendo la strada** invece di
     * riscrivere la formula che definisce il passo.
     *
     * La prima versione di questo test asseriva `tickSeconds === (REFRESH_MS/1000) × SCALE`, che è
     * la definizione di `tickSeconds` copiata nell'asserzione: non poteva fallire per nessuna
     * modifica al codice. Qui si conta quanti tick stanno in un secondo di tempo reale e si guarda
     * quanta strada ne esce: dev'essere quella che un veicolo a `speedKmH` copre in
     * `SIMULATED_TIME_SCALE` secondi. Un passo più lungo del dovuto — il difetto vero, un mondo che
     * avanza più in fretta di quanto lo si osservi — fallisce qui.
     */
    const ticksInOneRealSecond = 1000 / FLEET_POSITION_REFRESH_MS;
    const simulator = new FleetSimulator();
    simulator.followRoute('RT-01', DUOMO, [GARIBALDI]);

    const before = simulator.reading('RT-01')?.remainingKm ?? 0;
    for (let step = 0; step < ticksInOneRealSecond; step += 1) simulator.tick();
    const covered = before - (simulator.reading('RT-01')?.remainingKm ?? 0);

    /*
     * La tolleranza non è generosità: il simulatore consuma il budget di percorrenza sulla distanza
     * haversine e poi interpola le coordinate **in gradi**, quindi la strada rimasta ricalcolata
     * dopo un passo parziale differisce dal budget consumato di una frazione di millimetro. È lo
     * scarto che `interpolate()` dichiara — «meno di un metro su distanze urbane» — e sei cifre
     * decimali su un chilometro sono un millimetro: abbastanza stretto perché un passo sbagliato
     * anche di poco fallisca, abbastanza largo da non inseguire l'aritmetica in virgola mobile.
     */
    const expectedKm = (DEFAULT_SIMULATOR_SETTINGS.speedKmH * SIMULATED_TIME_SCALE) / 3600;
    expect(covered).toBeCloseTo(expectedKm, 6);
  });

  it('due simulatori con la stessa rotta e gli stessi tick finiscono nello stesso punto', () => {
    // Il determinismo non è un dettaglio: è ciò che permette al cancello di M7 di contare i tick
    // invece di aspettare, e ai test di non dipendere da quanto ha impiegato quello precedente.
    const first = new FleetSimulator(ONE_KM_PER_TICK);
    const second = new FleetSimulator(ONE_KM_PER_TICK);

    for (const simulator of [first, second]) {
      simulator.followRoute('RT-01', DUOMO, [CADORNA, GARIBALDI]);
      simulator.tick();
      simulator.tick();
    }

    expect(first.reading('RT-01')).toEqual(second.reading('RT-01'));
  });
});
