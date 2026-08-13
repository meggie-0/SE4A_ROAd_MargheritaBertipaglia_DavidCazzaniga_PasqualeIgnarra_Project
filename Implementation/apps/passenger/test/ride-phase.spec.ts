import type { NotificationPush, RideRequestResponse } from '@road/shared';

import { applyNotification, initialView } from '../src/ride-phase';

/**
 * La proiezione che l'app passeggero fa delle due macchine a stati del backend (DD §3.1).
 *
 * Non è una terza macchina — le transizioni le decide il server — ma la *lettura* che il passeggero
 * ne riceve, e sbagliarla significa mostrargli una corsa ferma mentre avanza. Sta qui perché è
 * l'unica logica non banale dei due client, ed è pura: due valori in ingresso, uno in uscita.
 *
 * La purezza non è un vezzo. La vista di stato si ricalcola riducendo **tutte** le notifiche della
 * corsa a ogni render, e questo è lecito solo se riapplicare la stessa notifica dà lo stesso
 * risultato: il primo test qui sotto è quella proprietà, e la versione precedente dell'app — che
 * teneva un cursore su quante ne avesse già applicate — si congelava proprio perché aveva cercato
 * di evitarla.
 */

const REQUEST: RideRequestResponse = {
  id: '7a0e3f2c-0000-4000-8000-000000000001',
  kind: 'IMMEDIATE',
  status: 'ACCEPTED',
  pickup: { lat: 45.4642, lon: 9.19 },
  pickupAddress: null,
  destination: { lat: 45.4781, lon: 9.227 },
  destinationAddress: null,
  assignedRobotaxiId: 'rt-04',
  scheduledPickup: null,
  createdAt: '2026-05-04T09:30:00.000Z',
};

const NOTHING = {
  type: null,
  message: '',
  occurredAt: '2026-05-04T09:30:10.000Z',
  rideRequestId: REQUEST.id,
  robotaxiId: 'rt-04',
  robotaxiState: null,
  rideStatus: null,
  strategy: null,
  mode: null,
  trafficLevel: null,
  zoneId: null,
  etaMinutes: null,
} satisfies NotificationPush;

const arriving: NotificationPush = {
  ...NOTHING,
  type: 'VEHICLE_ARRIVING',
  message: 'Il tuo robotaxi sta arrivando.',
  robotaxiState: 'ARRIVING',
  etaMinutes: 7,
};

const arrived: NotificationPush = {
  ...NOTHING,
  type: 'VEHICLE_ARRIVED',
  message: 'Il tuo robotaxi è al punto di ritiro.',
  robotaxiState: 'ARRIVED',
};

const inRide: NotificationPush = {
  ...NOTHING,
  type: 'RIDE_STATUS_CHANGED',
  message: 'Buon viaggio.',
  robotaxiState: 'IN_RIDE',
  rideStatus: 'IN_PROGRESS',
};

describe('[R3][R6][G2][G7] La vista di stato della corsa', () => {
  it('parte da assegnato quando la richiesta torna con un veicolo', () => {
    expect(initialView(REQUEST)).toMatchObject({ phase: 'assigned', robotaxiId: 'rt-04' });
  });

  it('resta in ricerca per una prenotazione accettata ma non ancora attivata', () => {
    // Fino all'attivazione il veicolo è *riservato*, non assegnato (decisione D9): chiamarlo
    // assegnato prometterebbe al passeggero più di quanto il sistema garantisca.
    const booking: RideRequestResponse = {
      ...REQUEST,
      kind: 'ADVANCE',
      assignedRobotaxiId: null,
      scheduledPickup: '2026-05-04T18:00:00.000Z',
    };

    expect(initialView(booking).phase).toBe('searching');
  });

  it('segue la progressione fino a in_ride', () => {
    const phases = [arriving, arrived, inRide].reduce(
      (steps, event) => [...steps, applyNotification(steps.at(-1) as never, event)],
      [initialView(REQUEST)],
    );

    expect(phases.map((view) => view.phase)).toEqual([
      'assigned',
      'arriving',
      'arrived',
      'in_ride',
    ]);
  });

  it('riapplicare la stessa sequenza dà lo stesso risultato', () => {
    // È la proprietà su cui poggia il ricalcolo della vista a ogni render. Se non valesse, un
    // secondo render mostrerebbe una fase diversa dal primo con gli stessi dati.
    const once = [arriving, arrived, inRide].reduce(applyNotification, initialView(REQUEST));
    const twice = [arriving, arrived, inRide, arriving, arrived, inRide].reduce(
      applyNotification,
      initialView(REQUEST),
    );

    expect(twice).toEqual(once);
  });

  it('mostra i minuti stimati mentre il veicolo arriva, e non dopo', () => {
    const approaching = applyNotification(initialView(REQUEST), arriving);
    expect(approaching.etaMinutes).toBe(7);

    // A passeggero a bordo, quel numero direbbe quanto ci avrebbe messo ad arrivare dove è già.
    expect(applyNotification(approaching, inRide).etaMinutes).toBeNull();
  });

  it('la fine della corsa vince sullo stato del veicolo che torna libero', () => {
    const completed: NotificationPush = {
      ...NOTHING,
      message: 'Corsa completata.',
      // Il veicolo torna `AVAILABLE`: preso da solo significherebbe «stiamo cercando un robotaxi».
      robotaxiState: 'AVAILABLE',
      rideStatus: 'COMPLETED',
    };

    expect(applyNotification(initialView(REQUEST), completed).phase).toBe('completed');
  });
});
