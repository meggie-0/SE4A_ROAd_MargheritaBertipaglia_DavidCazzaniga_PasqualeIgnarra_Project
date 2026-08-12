import {
  RideRequestNotFoundError,
  ScheduledPickupNotInFutureError,
} from '../../../src/rides/rides.port';
import { composeRides, vehicleAt, type RidesHarness } from '../../support/rides';

/**
 * Le decisioni che `RideRequestManager` prende **quando qualcosa va storto** (M4).
 *
 * Il cammino felice — richiesta, allocazione, riserva, assegnazione — è verificato dove ha senso
 * verificarlo, cioè su Postgres vero, nei test di integrazione e nel cancello di M4. Qui ci sono i
 * casi che su un database si costruirebbero governando l'interleaving di due transazioni: il
 * veicolo che qualcun altro si prende fra la scelta e la riserva, quello che finisce in officina
 * fra la lettura dei candidati e l'assegnazione, il fornitore di ETA che non sa rispondere. Sono
 * decisioni del coordinatore, e questo è il posto dove si leggono.
 */

const DUOMO = { lat: 45.4642, lon: 9.19 };
const CENTRALE = { lat: 45.4863, lon: 9.205 };
const NOW = new Date('2026-05-04T09:00:00.000Z');
const PASSENGER = 'passenger-1';

/** Il punto in cui un veicolo è più lontano di un altro dal Duomo, in modo prevedibile. */
const north = (id: string, degrees: number) =>
  vehicleAt(id, { lat: DUOMO.lat + degrees, lon: DUOMO.lon });

const immediateDraft = {
  passengerId: PASSENGER,
  pickup: DUOMO,
  destination: CENTRALE,
};

let harness: RidesHarness;

afterEach(async () => {
  await harness?.close();
});

describe('[R3][G2] Immediate ride request', () => {
  it('assegna il veicolo scelto e scrive la richiesta come accettata', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.05), north('RT-02', 0.01)],
    });

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;

    // `NEAREST_AVAILABLE` è la strategia di default: vince il più vicino al ritiro.
    expect(outcome.robotaxiId).toBe('RT-02');
    expect(outcome.request.status).toBe('ACCEPTED');
    expect(outcome.request.assignedRobotaxiId).toBe('RT-02');
    expect(harness.fleet.stateOf('RT-02')).toBe('ASSIGNED');
    // Una corsa immediata non produce una prenotazione: quella è la forma della corsa anticipata.
    expect(outcome.booking).toBeNull();
  });

  it('la riserva comincia adesso e finisce entro un intervallo limitato', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;

    // Decisione D8: nessuna riserva è illimitata, o bloccherebbe ogni prenotazione futura su quel
    // veicolo. Il limite inferiore è l'istante dell'assegnazione.
    expect(outcome.reservation.period.start).toEqual(NOW);
    expect(outcome.reservation.period.end.getTime()).toBeGreaterThan(NOW.getTime());
    expect(Number.isFinite(outcome.reservation.period.end.getTime())).toBe(true);
  });

  it('senza veicoli in flotta la richiesta è rifiutata, e resta scritta', async () => {
    harness = await composeRides({ now: NOW, vehicles: [] });

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted).toBe(false);
    if (outcome.accepted) return;

    // Il rifiuto è una riga con uno stato, non un'assenza: è il dato che dice quando la flotta è
    // sottodimensionata (RASD §2.2.1, `RequestStatus.REJECTED`).
    expect(outcome.reason).toBe('NO_ELIGIBLE_ROBOTAXI');
    expect(outcome.request.status).toBe('REJECTED');
    expect(harness.persistence.rowsOf('ride_request')).toHaveLength(1);
    expect(harness.persistence.rowsOf('robotaxi_reservation')).toHaveLength(0);
  });

  it('un veicolo già assegnato non è candidato: la richiesta successiva prende un altro', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });

    const first = await harness.rides.submitImmediate(immediateDraft);
    const second = await harness.rides.submitImmediate(immediateDraft);

    expect(first.accepted && first.robotaxiId).toBe('RT-01');
    expect(second.accepted && second.robotaxiId).toBe('RT-02');
  });

  it('se il veicolo scelto viene impegnato da un altro, ne prova un secondo', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });
    // RT-01 è il più vicino, quindi la strategia lo sceglie per primo; fra la scelta e la riserva
    // un'altra transazione lo blocca. È la corsa che il §2.4 prevede con `ROBOTAXI_BUSY`.
    harness.persistence.blockReservationsFor('RT-01', 'ROBOTAXI_BUSY');

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted).toBe(true);
    expect(outcome.accepted && outcome.robotaxiId).toBe('RT-02');
    // E il veicolo perso non è stato assegnato per sbaglio.
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('se la finestra del veicolo scelto collide, ne prova un secondo', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });
    harness.persistence.blockReservationsFor('RT-01', 'OVERLAPPING_RESERVATION');

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted && outcome.robotaxiId).toBe('RT-02');
  });

  it('se tutti i candidati sfumano, la richiesta è rifiutata e nessuna riserva resta appesa', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });
    harness.persistence.blockReservationsFor('RT-01', 'ROBOTAXI_BUSY');
    harness.persistence.blockReservationsFor('RT-02', 'ROBOTAXI_BUSY');

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted).toBe(false);
    expect(outcome.request.status).toBe('REJECTED');
    expect(harness.persistence.rowsOf('robotaxi_reservation')).toHaveLength(0);
  });

  it('un veicolo di cui non si conosce il tempo di arrivo non viene assegnato', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });
    // Il fornitore non sa rispondere per RT-01. Senza un ETA non esiste una finestra **limitata**
    // da riservare (decisione D8), quindi quel veicolo non è utilizzabile: si passa al successivo
    // invece di inventarne una durata.
    harness.external.forget('RT-01');

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted && outcome.robotaxiId).toBe('RT-02');
  });

  it('se non si conosce la durata della corsa, nessuna riserva viene scritta', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    harness.external.forget('pickup');

    const outcome = await harness.rides.submitImmediate(immediateDraft);

    expect(outcome.accepted).toBe(false);
    expect(harness.persistence.rowsOf('robotaxi_reservation')).toHaveLength(0);
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });
});

describe('[R4][G3] Advance booking', () => {
  const inTwoHours = new Date(NOW.getTime() + 2 * 60 * 60 * 1000);

  const advanceDraft = { ...immediateDraft, scheduledPickup: inTwoHours };

  it('riserva il veicolo ma non lo assegna: resta libero fino all attivazione', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });

    const outcome = await harness.rides.submitAdvance(advanceDraft);

    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;

    expect(outcome.request.status).toBe('ACCEPTED');
    expect(outcome.booking?.robotaxiId).toBe('RT-01');
    // Il veicolo è **riservato**, non assegnato: è la differenza fra la Figura 2.5 e la 2.8, ed è
    // ciò che gli permette di servire corse immediate nelle due ore che mancano.
    expect(outcome.request.assignedRobotaxiId).toBeNull();
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('la prenotazione porta l istante di attivazione, anticipato rispetto all orario', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });

    const outcome = await harness.rides.submitAdvance(advanceDraft);

    expect(outcome.accepted).toBe(true);
    // `booking` va asserito **prima** del `return`: se `submitAdvance` smettesse di passare la
    // prenotazione a `reserve()`, un `return` non asserito farebbe uscire il test verde saltando
    // tutto ciò che segue — cioè proprio il difetto che questo caso esiste per escludere.
    expect(outcome.accepted && outcome.booking).not.toBeNull();
    if (!outcome.accepted || outcome.booking === null) return;

    expect(outcome.booking.scheduledPickup).toEqual(inTwoHours);
    // L'anticipo di default è di 15 minuti (MILESTONES.md §M1).
    expect(outcome.booking.activationDueAt).toEqual(new Date(inTwoHours.getTime() - 15 * 60_000));
    expect(outcome.booking.activatedAt).toBeNull();
  });

  it('un orario non futuro è rifiutato prima di scrivere qualunque riga', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });

    await expect(
      harness.rides.submitAdvance({ ...advanceDraft, scheduledPickup: NOW }),
    ).rejects.toBeInstanceOf(ScheduledPickupNotInFutureError);

    // Una richiesta malformata non lascia una riga `PENDING` che nessuno raccoglierà mai.
    expect(harness.persistence.rowsOf('ride_request')).toHaveLength(0);
  });

  it('due prenotazioni sulla stessa finestra non prendono lo stesso veicolo', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });

    const first = await harness.rides.submitAdvance(advanceDraft);
    const second = await harness.rides.submitAdvance(advanceDraft);

    expect(first.accepted && first.robotaxiId).toBe('RT-01');
    expect(second.accepted && second.robotaxiId).toBe('RT-02');
  });

  it('esaurita la flotta su quella finestra, la prenotazione è rifiutata', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });

    await harness.rides.submitAdvance(advanceDraft);
    const second = await harness.rides.submitAdvance(advanceDraft);

    expect(second.accepted).toBe(false);
    expect(second.request.status).toBe('REJECTED');
  });

  it('si prenota un veicolo occupato adesso ma libero all orario richiesto', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });

    // L'unico veicolo della flotta sta servendo una corsa in questo momento.
    const running = await harness.rides.submitImmediate(immediateDraft);
    expect(running.accepted).toBe(true);
    expect(harness.fleet.stateOf('RT-01')).toBe('ASSIGNED');

    // La prenotazione è per fra due ore, quando quella corsa sarà finita da un pezzo. Il veicolo
    // **non è allocabile adesso**, ma è prenotabile: a decidere è la timeline, non lo stato
    // istantaneo (decisione D34). Con i soli candidati allocabili, R4 rifiuterebbe ogni
    // prenotazione futura appena la flotta è impegnata — cioè funzionerebbe solo quando non serve.
    const booked = await harness.rides.submitAdvance(advanceDraft);

    expect(booked.accepted && booked.robotaxiId).toBe('RT-01');
    // E la corsa in esecuzione non è stata toccata: la prenotazione riserva, non assegna.
    expect(harness.fleet.stateOf('RT-01')).toBe('ASSIGNED');
  });

  it('ma non uno in manutenzione: non si sa quando tornerà', async () => {
    harness = await composeRides({
      now: NOW,
      vehicles: [north('RT-01', 0.01), north('RT-02', 0.05)],
    });
    harness.fleet.setState('RT-01', 'MAINTENANCE');

    const booked = await harness.rides.submitAdvance(advanceDraft);

    // Un intervento non ha una data di fine prevista, quindi prenotare quel veicolo prometterebbe
    // una corsa su un'ipotesi. È la lettura conservativa di R9.
    expect(booked.accepted && booked.robotaxiId).toBe('RT-02');
  });

  it('una finestra che non si sovrappone resta prenotabile sullo stesso veicolo', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });

    const morning = await harness.rides.submitAdvance(advanceDraft);
    const evening = await harness.rides.submitAdvance({
      ...advanceDraft,
      scheduledPickup: new Date(NOW.getTime() + 8 * 60 * 60 * 1000),
    });

    // La riserva copre un intervallo **limitato** (decisione D8): otto ore dopo il veicolo è di
    // nuovo prenotabile. Con un intervallo aperto in coda, questa seconda prenotazione fallirebbe.
    expect(morning.accepted && morning.robotaxiId).toBe('RT-01');
    expect(evening.accepted && evening.robotaxiId).toBe('RT-01');
  });
});

describe('[R14] Ride Cancellation', () => {
  it('libera il veicolo assegnato e rilascia la riserva', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const outcome = await harness.rides.submitImmediate(immediateDraft);

    const cancellation = await harness.rides.cancel(outcome.request.id, PASSENGER);

    expect(cancellation.request.status).toBe('CANCELLED');
    expect(cancellation.request.assignedRobotaxiId).toBeNull();
    expect(cancellation.releasedRobotaxiId).toBe('RT-01');
    expect(cancellation.releasedReservations).toBe(1);
    // Transizione 11 della Figura 2.10: il veicolo torna fra i disponibili.
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');
  });

  it('e la finestra liberata torna prenotabile dallo stesso veicolo', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const first = await harness.rides.submitImmediate(immediateDraft);

    await harness.rides.cancel(first.request.id, PASSENGER);
    const second = await harness.rides.submitImmediate(immediateDraft);

    // È l'effetto osservabile che R14 enuncia: senza il rilascio, la riserva della corsa annullata
    // escluderebbe RT-01 e questa seconda richiesta sarebbe rifiutata.
    expect(second.accepted && second.robotaxiId).toBe('RT-01');
  });

  it('annulla una prenotazione anticipata prima che la sua finestra cominci', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const booked = await harness.rides.submitAdvance({
      ...immediateDraft,
      scheduledPickup: new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
    });

    const cancellation = await harness.rides.cancel(booked.request.id, PASSENGER);

    // Nessun veicolo da liberare: la prenotazione non era ancora stata attivata.
    expect(cancellation.releasedRobotaxiId).toBeNull();
    expect(cancellation.releasedReservations).toBe(1);
    // La prenotazione perde il puntatore alla riserva rilasciata, ma la riga resta per lo storico.
    expect(cancellation.booking?.reservationId).toBeNull();
    expect(harness.persistence.rowsOf('booking')).toHaveLength(1);
  });

  it('la corsa di un altro passeggero non esiste', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const outcome = await harness.rides.submitImmediate(immediateDraft);

    // Stesso errore di un identificatore inventato: distinguerli permetterebbe di scoprire quali
    // corse esistono provandoli uno per uno.
    await expect(harness.rides.cancel(outcome.request.id, 'passenger-2')).rejects.toBeInstanceOf(
      RideRequestNotFoundError,
    );
    await expect(harness.rides.cancel('non-esiste', PASSENGER)).rejects.toBeInstanceOf(
      RideRequestNotFoundError,
    );
    // E niente è cambiato.
    expect(harness.fleet.stateOf('RT-01')).toBe('ASSIGNED');
  });

  it('non si annulla due volte', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const outcome = await harness.rides.submitImmediate(immediateDraft);
    await harness.rides.cancel(outcome.request.id, PASSENGER);

    await expect(harness.rides.cancel(outcome.request.id, PASSENGER)).rejects.toMatchObject({
      name: 'RideNotCancellableError',
      refusal: 'REQUEST_NOT_ACTIVE',
    });
  });

  /**
   * La **seconda metà di R14**, che nasce con M7 (decisione D59).
   *
   * Fino a M6 l'annullamento si fermava al veicolo assegnato e fermo: da `ARRIVING` in poi veniva
   * rifiutato, perché riportare fra i disponibili un veicolo in movimento richiede di revocargli la
   * rotta e `commandRoute()` non esisteva (DD §2.6.3, decisione D27). Adesso esiste, e le due righe
   * mancanti della Figura 2.10 — transizioni 12 e 13 — sono state aggiunte.
   */
  it.each([
    ['ARRIVING' as const, 'in avvicinamento al punto di ritiro'],
    ['ARRIVED' as const, 'fermo al punto di ritiro ad aspettare'],
  ])('si annulla con il veicolo %s (%s), revocandogli la rotta', async (state, _situation) => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const outcome = await harness.rides.submitImmediate(immediateDraft);
    harness.fleet.setState('RT-01', state);

    const cancellation = await harness.rides.cancel(outcome.request.id, PASSENGER);

    expect(cancellation.request.status).toBe('CANCELLED');
    expect(cancellation.releasedRobotaxiId).toBe('RT-01');
    expect(harness.fleet.stateOf('RT-01')).toBe('AVAILABLE');

    /**
     * **La rotta si revoca prima di liberare il veicolo**, e l'ordine è il requisito.
     *
     * Un veicolo dichiarato disponibile mentre percorre ancora la rotta verso un passeggero che ha
     * annullato potrebbe essere assegnato a qualcun altro *e continuare ad andare dove non serve
     * più*. Il doppio registra i comandi in ordine, quindi la revoca deve essere l'ultimo comando
     * ricevuto e deve esserci.
     */
    expect(harness.external.routeCommands).toEqual([{ robotaxiId: 'RT-01', destination: null }]);
  });

  it('non si annulla una corsa già cominciata, e il rifiuto non tocca nulla', async () => {
    harness = await composeRides({ now: NOW, vehicles: [north('RT-01', 0.01)] });
    const outcome = await harness.rides.submitImmediate(immediateDraft);
    // Il passeggero è a bordo: la corsa è cominciata davvero (RASD §1.2.2), e R14 ammette
    // l'annullamento solo «before the ride begins». È l'unico stato in cui il rifiuto resta.
    harness.fleet.setState('RT-01', 'IN_RIDE');

    await expect(harness.rides.cancel(outcome.request.id, PASSENGER)).rejects.toMatchObject({
      name: 'RideNotCancellableError',
      refusal: 'RIDE_ALREADY_UNDER_WAY',
    });

    // **Il veicolo si libera prima della riserva**, quindi un rifiuto lascia tutto com'era: la
    // finestra resta impegnata e la richiesta accettata, che è ciò che deve essere se la corsa
    // sta comunque per avvenire.
    const [reservation] = harness.persistence.rowsOf('robotaxi_reservation');
    expect(reservation?.releasedAt).toBeNull();
    const [request] = harness.persistence.rowsOf('ride_request');
    expect(request?.status).toBe('ACCEPTED');
  });
});
