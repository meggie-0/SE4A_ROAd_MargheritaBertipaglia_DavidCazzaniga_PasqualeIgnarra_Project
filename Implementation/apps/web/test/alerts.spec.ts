import type { NotificationPush } from '@road/shared';

import { alertCategoryOf } from '../src/alerts';

/**
 * Il pannello alert della dashboard (DD §3.2; RASD R11, R12; G9).
 *
 * Questo test esiste per un difetto vero, trovato in revisione e non da nessun controllo
 * automatico: il filtro riconosceva un riposizionamento dal `type` `REBALANCING_ALERT`, che il
 * backend **non emette mai** — `notification-copy.ts` lo lascia da parte di proposito, perché
 * assegnarlo scriverebbe una `Notification` senza destinatario. L'effetto era che il pannello che
 * il DD §3.2 descrive come «automatic strategy switches **and rebalancing suggestions**» ne
 * mostrava metà, e nulla se ne accorgeva: un filtro troppo stretto non solleva, mostra di meno.
 *
 * Le notifiche qui sotto sono costruite nella forma **esatta** in cui il backend le spedisce.
 */

const NOTHING = {
  type: null,
  message: '',
  occurredAt: '2026-05-04T19:30:00.000Z',
  rideRequestId: null,
  robotaxiId: null,
  robotaxiState: null,
  rideStatus: null,
  strategy: null,
  mode: null,
  trafficLevel: null,
  zoneId: null,
  etaMinutes: null,
} satisfies NotificationPush;

describe('[R11][R12][G9] Alert della dashboard operatore', () => {
  it('riconosce un riposizionamento, che arriva con type nullo', () => {
    // La forma di `REBALANCING_STARTED`: nessun tipo, nessun livello di traffico, nessun modo —
    // solo il veicolo e la zona verso cui è stato mandato.
    const event: NotificationPush = {
      ...NOTHING,
      message: 'Il robotaxi rt-07 si sta riposizionando verso San Siro.',
      robotaxiId: 'rt-07',
      zoneId: 'san-siro',
    };

    expect(alertCategoryOf(event)).toBe('rebalancing');
  });

  it('riconosce uno switch automatico di strategia', () => {
    const event: NotificationPush = {
      ...NOTHING,
      message: 'Strategia commutata automaticamente a ETA minimo.',
      strategy: 'MINIMUM_ETA',
      mode: 'AUTO',
      trafficLevel: 'HIGH',
    };

    expect(alertCategoryOf(event)).toBe('high');
  });

  it('riconosce l alert della soglia intermedia, che non commuta niente', () => {
    const event: NotificationPush = {
      ...NOTHING,
      message: 'Traffico MEDIUM: valutare il passaggio alla strategia ETA minimo.',
      trafficLevel: 'MEDIUM',
      strategy: 'MINIMUM_ETA',
    };

    expect(alertCategoryOf(event)).toBe('medium');
  });

  it('riconosce il rientro in modo Auto, che non porta un livello di traffico', () => {
    const event: NotificationPush = {
      ...NOTHING,
      message: 'Modo automatico riabilitato.',
      mode: 'AUTO',
      strategy: 'NEAREST_AVAILABLE',
    };

    expect(alertCategoryOf(event)).toBe('mode');
  });

  it.each([
    ['assegnazione', { robotaxiState: 'ASSIGNED' as const, rideRequestId: 'r-1' }],
    ['avvicinamento', { robotaxiState: 'ARRIVING' as const, etaMinutes: 7 }],
    ['fine corsa', { rideStatus: 'COMPLETED' as const }],
  ])('non mostra %s, che è un fatto della corsa e si vede sulla mappa', (_name, fields) => {
    // Il pannello non è un registro di tutto ciò che passa sul canale: gli eventi del ciclo di
    // vita di una corsa riguardano il passeggero, e all'operatore la flotta la racconta la mappa.
    expect(alertCategoryOf({ ...NOTHING, ...fields })).toBeNull();
  });
});
