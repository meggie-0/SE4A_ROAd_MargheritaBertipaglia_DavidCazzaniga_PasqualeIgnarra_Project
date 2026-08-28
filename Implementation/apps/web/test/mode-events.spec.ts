import type { ModeResponse, NotificationPush } from '@road/shared';

import { applyModeEvent } from '../src/mode-events';

/**
 * Come gli eventi del canale aggiornano il pannello strategia (RASD R12, R13; DD §3.2, decisione
 * D75).
 *
 * Questo file esiste per un difetto vero, che tutti i controlli esistenti hanno lasciato passare: i
 * test coprivano la funzione pura dell'aspetto (`traffic-levels.spec.ts`) e la lettura HTTP (cancello
 * M6, integrazione, scenario 3), tutti verdi, e **nessuno guardava se il valore mostrato cambia**.
 * Il badge poteva restare fermo su «Basso» mentre il pannello alert accanto annunciava `MEDIUM`, e
 * niente ne sollevava.
 *
 * Le notifiche qui sotto sono costruite nella forma **esatta** in cui il backend le spedisce:
 * `NOTHING` riproduce la costante omonima di `notification-copy.ts`, da cui ogni evento parte.
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

/** Ciò che la dashboard sta mostrando prima dell'evento. */
const SHOWING: ModeResponse = {
  mode: 'AUTO',
  activeStrategy: 'NEAREST_AVAILABLE',
  trafficLevel: 'LOW',
};

describe('[R12][NFR9] Il livello di traffico segue gli eventi che lo portano', () => {
  it('applica un TRAFFIC_ALERT, che non porta il modo', () => {
    /**
     * **Il difetto, nella sua forma esatta.**
     *
     * `TRAFFIC_ALERT` nasce dalla costante `NOTHING` e valorizza `trafficLevel` e `strategy`, mai
     * `mode`. Un client che riconosca gli eventi dal solo modo lo scarta per intero — livello
     * compreso — e allora al passaggio `LOW → MEDIUM` il pannello alert mostra «Traffico MEDIUM:
     * valutare il passaggio…» mentre il badge accanto continua a dire «Basso». Due parti della
     * stessa schermata che si contraddicono.
     *
     * È il caso peggiore possibile, perché la banda morta di `MEDIUM` — il sistema *ha* valutato e
     * ha deciso di **non** commutare — è la ragione per cui l'indicatore esiste (decisione D75).
     */
    const alert: NotificationPush = {
      ...NOTHING,
      message: 'Traffico MEDIUM: valutare il passaggio alla strategia ETA minimo.',
      trafficLevel: 'MEDIUM',
      strategy: 'MINIMUM_ETA',
      occurredAt: '2026-05-04T19:31:00.000Z',
    };

    expect(applyModeEvent(SHOWING, alert, null)?.trafficLevel).toBe('MEDIUM');
  });

  it('non perde il modo mostrato mentre aggiorna il livello', () => {
    /**
     * L'oggetto **sostituisce** la risposta in cache, quindi un campo non riportato sparirebbe. Qui
     * il rischio è preciso: `TRAFFIC_ALERT` è un suggerimento e non commuta niente, quindi un modo
     * `MANUAL` che diventasse `AUTO` per effetto di un alert direbbe all'operatore che il sistema ha
     * ripreso il controllo — l'esatto contrario di quanto NFR10 gli promette.
     */
    const alert: NotificationPush = {
      ...NOTHING,
      trafficLevel: 'HIGH',
      occurredAt: '2026-05-04T19:31:00.000Z',
    };

    const manual: ModeResponse = { ...SHOWING, mode: 'MANUAL', activeStrategy: 'MINIMUM_ETA' };
    const next = applyModeEvent(manual, alert, null);

    expect(next?.mode).toBe('MANUAL');
    expect(next?.activeStrategy).toBe('MINIMUM_ETA');
    expect(next?.trafficLevel).toBe('HIGH');
  });

  it('ignora un evento più vecchio di quello già applicato', () => {
    /**
     * Fra una notifica e la risposta di una `PUT` può arrivare prima l'una o l'altra: senza il
     * confronto sull'istante, un evento vecchio di un secondo sovrascriverebbe il risultato di un
     * comando appena eseguito. `occurredAt` è l'istante del **cambiamento**, non della consegna.
     */
    const stale: NotificationPush = {
      ...NOTHING,
      trafficLevel: 'LOW',
      occurredAt: '2026-05-04T19:29:00.000Z',
    };

    const showing: ModeResponse = { ...SHOWING, trafficLevel: 'HIGH' };

    expect(applyModeEvent(showing, stale, '2026-05-04T19:30:00.000Z')).toBe(showing);
  });

  it('non inventa niente quando la cache è ancora vuota', () => {
    /**
     * Un evento porta ciò che è cambiato, non lo stato intero. Completarne i buchi con dei default
     * significherebbe mostrare come letti dei valori che nessuno ha letto — la stessa distinzione
     * per cui `trafficLevel` è annullabile invece di valere `LOW` a sistema appena avviato. La
     * risposta di `GET /mode` arriva comunque, ed è autorevole.
     */
    const alert: NotificationPush = { ...NOTHING, trafficLevel: 'MEDIUM' };

    expect(applyModeEvent(undefined, alert, null)).toBeUndefined();
  });
});

describe('[R13][NFR10] Una scelta manuale non cancella il livello osservato', () => {
  it('conserva il livello quando l’evento non ne porta uno', () => {
    /**
     * `STRATEGY_CHANGED` con `source: 'manual'` nasce da una scelta umana e ha `trafficLevel` nullo
     * quando nessuna osservazione è ancora arrivata. Senza il ripiego, prendere il controllo della
     * flotta svuoterebbe dallo schermo un livello perfettamente valido — e in Manual il livello è
     * proprio ciò che serve all'operatore per decidere se il suo intervento ha ancora senso, perché
     * lì le osservazioni si registrano senza commutare niente (D20, R13).
     */
    const manualChoice: NotificationPush = {
      ...NOTHING,
      message: 'Il sistema è passato in modo Manual: resta attiva la strategia ETA minimo.',
      mode: 'MANUAL',
      strategy: 'MINIMUM_ETA',
      occurredAt: '2026-05-04T19:31:00.000Z',
    };

    const next = applyModeEvent(SHOWING, manualChoice, null);

    expect(next?.mode).toBe('MANUAL');
    expect(next?.trafficLevel).toBe('LOW');
  });
});
