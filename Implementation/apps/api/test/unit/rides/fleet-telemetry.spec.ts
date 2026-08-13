import { BOARDING_SECONDS } from '../../../src/rides/fleet-telemetry.port';
import { composeRides, type RidesHarness } from '../../support/rides';

/**
 * La telemetria che fa avanzare le corse (M7, decisione D61).
 *
 * Fino a M6 le quattro transizioni della corsa le chiamavano i test, uno per volta: la Figura 2.10
 * lascia aperte le guardie che dipendono dalla posizione del veicolo — `hasReachedPickup()`,
 * `hasReachedDestination()` — e senza telemetria nessuno sapeva dire *quando*. Qui si verifica il
 * componente che quel «quando» lo decide.
 *
 * La composizione è quella di M4 e M5: archivio in memoria, `FleetDouble` al posto della flotta,
 * `TravelTimeDouble` al posto dei fornitori — dove «arrivare» è una cosa che il test dichiara, con
 * `arrive()`, invece di far percorrere davvero una polyline. La polyline vera la percorre
 * `@road/simulator`, ed è verificata nei suoi test e nel cancello di M7, su Postgres. Qui interessa
 * un'altra cosa: che il giro faccia il passo **giusto** al momento giusto, e nessuno quando non
 * deve.
 */

const NOW = new Date('2026-05-04T09:00:00.000Z');
const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };
const GIULIA = 'passeggero-giulia';

let harness: RidesHarness;

const vehicle = (id: string) => ({
  id,
  state: 'AVAILABLE' as const,
  lat: DUOMO.lat + 0.01,
  lon: DUOMO.lon,
  zoneId: 'duomo',
  updatedAt: NOW,
});

/**
 * Fa scadere la sosta al punto di ritiro (decisione D63).
 *
 * L'orologio si porta avanti della quantità che la porta dichiara, non di un numero scritto qui:
 * cambiare `BOARDING_SECONDS` deve far cambiare i test insieme al codice, non farli fallire.
 */
function boardingTimeElapses(): void {
  harness.clock.advance(BOARDING_SECONDS * 1000);
}

async function givenAcceptedRide(): Promise<string> {
  const outcome = await harness.rides.submitImmediate({
    passengerId: GIULIA,
    pickup: DUOMO,
    destination: CENTRALE,
  });
  expect(outcome.accepted).toBe(true);
  return outcome.request.id;
}

beforeEach(async () => {
  harness = await composeRides({ now: NOW, vehicles: [vehicle('RT-01')] });
});

afterEach(async () => {
  await harness?.close();
});

describe('[R6][G7] La telemetria fa avanzare la corsa', () => {
  it('il primo giro comanda la rotta verso il ritiro e manda il veicolo in avvicinamento', async () => {
    const rideRequestId = await givenAcceptedRide();

    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([
      { rideRequestId, robotaxiId: 'RT-01', step: 'PICKUP_NAVIGATION_STARTED' },
    ]);
    expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVING');
    // La rotta è stata comandata **verso il punto di ritiro**, non verso la destinazione.
    expect(harness.external.routeCommands).toEqual([{ robotaxiId: 'RT-01', destination: DUOMO }]);
  });

  it('finché il veicolo non è arrivato, i giri successivi non fanno niente', async () => {
    await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();

    const second = await harness.fleetTelemetry.runOnce();
    const third = await harness.fleetTelemetry.runOnce();

    expect(second.advanced).toEqual([]);
    expect(third.advanced).toEqual([]);
    expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVING');
  });

  it('la catena completa: avvicinamento, ritiro, partenza, arrivo a destinazione', async () => {
    const rideRequestId = await givenAcceptedRide();

    await harness.fleetTelemetry.runOnce(); // → ARRIVING, rotta verso il ritiro
    harness.external.arrive('RT-01'); // il veicolo raggiunge il ritiro
    await harness.fleetTelemetry.runOnce(); // → ARRIVED
    boardingTimeElapses(); // il passeggero sale (decisione D63)
    await harness.fleetTelemetry.runOnce(); // → IN_RIDE, rotta verso la destinazione
    harness.external.arrive('RT-01'); // il veicolo raggiunge la destinazione
    const last = await harness.fleetTelemetry.runOnce(); // → corsa completata

    expect(last.advanced).toEqual([{ rideRequestId, robotaxiId: 'RT-01', step: 'RIDE_COMPLETED' }]);
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');

    const [request] = harness.persistence
      .rowsOf('ride_request')
      .filter((row) => row.id === rideRequestId);
    expect(request?.status).toBe('COMPLETED');

    /**
     * I comandi di rotta raccontano il viaggio: al ritiro, poi a destinazione, poi la **revoca**.
     *
     * L'ultima riga è quella che conta: un veicolo tornato disponibile senza revoca continuerebbe a
     * dichiararsi «arrivato» alla destinazione di una corsa che non esiste più, e il giro
     * successivo lo troverebbe fermo su un fatto vecchio.
     */
    expect(harness.external.routeCommands).toEqual([
      { robotaxiId: 'RT-01', destination: DUOMO },
      { robotaxiId: 'RT-01', destination: CENTRALE },
      { robotaxiId: 'RT-01', destination: null },
    ]);
  });

  it('arrivare al ritiro non chiude la corsa: il punto raggiunto viene confrontato', async () => {
    await givenAcceptedRide();

    await harness.fleetTelemetry.runOnce();
    harness.external.arrive('RT-01');
    await harness.fleetTelemetry.runOnce();
    boardingTimeElapses();
    // Il veicolo è fermo al ritiro e la telemetria continua a dire «arrivato»: se il giro
    // guardasse solo quel campo, e non **dove**, farebbe partire e concludere la corsa in un colpo.
    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([expect.objectContaining({ step: 'RIDE_STARTED' })]);
    expect(harness.fleet.stateOf('RT-01')).toBe('IN_RIDE');
  });

  describe('[R6][NFR5] La sosta al punto di ritiro dura un tempo, non un giro', () => {
    /**
     * La decisione D63 assume che il passeggero salga da sé, perché nessun sensore sa dire se sia
     * salito davvero. Fino a M8 quell'assunzione era espressa in **cicli** — «al giro successivo
     * all'arrivo» — e con la telemetria a mezzo secondo faceva durare lo stato `arrived` mezzo
     * secondo: il passeggero non faceva in tempo a leggere che il suo robotaxi era arrivato.
     *
     * Questi tre casi sono la nuova formulazione, e il primo è quello che la vecchia non superava.
     */
    async function givenVehicleWaitingAtPickup(): Promise<void> {
      await givenAcceptedRide();
      await harness.fleetTelemetry.runOnce();
      harness.external.arrive('RT-01');
      await harness.fleetTelemetry.runOnce();
      expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVED');
    }

    it('finché la sosta non è scaduta la corsa non parte, per quanti giri passino', async () => {
      await givenVehicleWaitingAtPickup();

      // Venti giri: con il passo di mezzo secondo sono dieci secondi di telemetria, ma l'orologio
      // non si è mosso. È il numero di giri a non contare, ed è il punto.
      for (let giro = 0; giro < 20; giro += 1) {
        expect((await harness.fleetTelemetry.runOnce()).advanced).toEqual([]);
      }
      expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVED');
    });

    it('un istante prima della scadenza è ancora presto', async () => {
      await givenVehicleWaitingAtPickup();

      // Il valore di frontiera dal lato che non deve passare: senza, un confronto scritto con `>`
      // invece che con `>=` — o con l'unità sbagliata — passerebbe inosservato.
      harness.clock.advance(BOARDING_SECONDS * 1000 - 1);

      expect((await harness.fleetTelemetry.runOnce()).advanced).toEqual([]);
      expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVED');
    });

    it('scaduta la sosta, il primo giro utile fa partire la corsa', async () => {
      await givenVehicleWaitingAtPickup();
      boardingTimeElapses();

      const cycle = await harness.fleetTelemetry.runOnce();

      expect(cycle.advanced).toEqual([expect.objectContaining({ step: 'RIDE_STARTED' })]);
      expect(harness.fleet.stateOf('RT-01')).toBe('IN_RIDE');
      // E la rotta verso la destinazione parte con la corsa, non prima: un veicolo mandato a
      // destinazione mentre il passeggero sale se ne andrebbe senza di lui.
      expect(harness.external.routeCommands.at(-1)).toEqual({
        robotaxiId: 'RT-01',
        destination: CENTRALE,
      });
    });
  });

  it('un veicolo in avvicinamento che ha perso la rotta la riceve di nuovo', async () => {
    await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();
    expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVING');

    /**
     * La rotta sparisce dalla flotta mentre lo stato `ARRIVING` resta in colonna.
     *
     * Non è un caso di laboratorio: lo stato del veicolo è persistito, il mondo del simulatore vive
     * in memoria, quindi **basta un riavvio del processo**. Senza il ramo di recupero la corsa
     * resterebbe ferma per sempre — nessun tick la muoverebbe e nessun giro se ne accorgerebbe.
     */
    await harness.external.commandRoute('RT-01', null);
    harness.external.routeCommands.length = 0;

    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([]);
    expect(harness.fleet.stateOf('RT-01')).toBe('ARRIVING');
    expect(harness.external.routeCommands).toEqual([{ robotaxiId: 'RT-01', destination: DUOMO }]);

    // E da lì la corsa riprende normalmente.
    harness.external.arrive('RT-01');
    const resumed = await harness.fleetTelemetry.runOnce();
    expect(resumed.advanced).toEqual([expect.objectContaining({ step: 'PICKUP_REACHED' })]);
  });

  it('un veicolo che sta già viaggiando verso il ritiro non riceve comandi inutili', async () => {
    await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();
    harness.external.routeCommands.length = 0;

    await harness.fleetTelemetry.runOnce();
    await harness.fleetTelemetry.runOnce();

    // Il recupero scatta sull'assenza di una rotta verso il ritiro, non a ogni giro: ricomandarla
    // continuamente ricalcolerebbe lo stesso percorso e, con OSRM configurato, sarebbe una
    // richiesta di rete per ogni veicolo per ogni giro.
    expect(harness.external.routeCommands).toEqual([]);
  });

  it('le posizioni osservate finiscono in tabella, anche per chi non sta servendo nessuno', async () => {
    await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();

    const cycle = await harness.fleetTelemetry.runOnce();

    // Un veicolo in movimento è un veicolo di cui l'operatore deve poter vedere la posizione (R7).
    expect(cycle.positionsRecorded).toBe(1);
    expect(cycle.observedAt).toEqual(NOW);
  });

  it('senza corse in corso il giro non fa nulla e non solleva', async () => {
    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([]);
    expect(cycle.positionsRecorded).toBe(0);
    expect(harness.external.routeCommands).toEqual([]);
  });

  it('una corsa annullata non avanza più, e il giro prosegue senza sollevare', async () => {
    const rideRequestId = await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();
    await harness.rides.cancel(rideRequestId, GIULIA);

    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([]);
    // L'annullamento ha riportato il veicolo fra i disponibili, e la telemetria non lo rimuove.
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('un veicolo portato via da qualcun altro non ferma il giro', async () => {
    const rideRequestId = await givenAcceptedRide();
    await harness.fleetTelemetry.runOnce();

    // Fra un giro e l'altro il veicolo finisce in manutenzione: la transizione successiva verrà
    // rifiutata dalla macchina a stati, e il giro deve limitarsi a saltarla.
    harness.fleet.setState('RT-01', 'MAINTENANCE');
    harness.external.arrive('RT-01');

    const cycle = await harness.fleetTelemetry.runOnce();

    expect(cycle.advanced).toEqual([]);
    expect(harness.fleet.stateOf('RT-01')).toBe('MAINTENANCE');

    // E il giro dopo riparte da dove il veicolo si trova davvero, senza ricordare nulla.
    const again = await harness.fleetTelemetry.runOnce();
    expect(again.advanced).toEqual([]);
    expect(rideRequestId).toBeDefined();
  });
});
