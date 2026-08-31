import type { NotificationPush, OperatorAlert } from '@road/shared';

import { mergeOperatorAlerts } from '../src/operator-alerts';

/**
 * La fusione fra storico e canale nel pannello alert (decisione D77; RASD R11, R12, R13; G9).
 *
 * Il difetto che questi casi difendono è quello che si vede in dimostrazione: sei riposizionamenti
 * accadono, si ricarica la pagina, e la dashboard dichiara di non aver fatto niente. La correzione
 * ha però un rischio proprio — le due sorgenti raccontano gli **stessi** fatti nella finestra in cui
 * si sovrappongono — e una deduplicazione sbagliata non solleva: mostra ogni alert due volte, oppure
 * ne fa sparire uno vero.
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

const STORICO: OperatorAlert = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'REBALANCING_STARTED',
  message: 'Il robotaxi RT-07 si sta riposizionando verso San Siro.',
  occurredAt: '2026-05-04T19:28:00.000Z',
  strategy: null,
  mode: null,
  trafficLevel: null,
  zoneId: 'san-siro',
  robotaxiId: 'RT-07',
};

describe('[R11][R12][G9] Il pannello alert ha una storia, non solo una diretta', () => {
  it('mostra ciò che è successo prima che la scheda esistesse', () => {
    /**
     * Il difetto, nella sua forma esatta: senza storico questo elenco sarebbe vuoto, e la dashboard
     * di un sistema che ha appena riposizionato un veicolo direbbe «nessun alert».
     */
    const merged = mergeOperatorAlerts([STORICO], [], 12);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.message).toContain('San Siro');
    expect(merged[0]?.category).toBe('rebalancing');
  });

  it('non mostra due volte il fatto che entrambe le sorgenti raccontano', () => {
    /**
     * È il rischio introdotto dalla correzione. Nella finestra in cui la scheda è aperta, un alert
     * arriva **sia** dalla socket **sia** dalla rilettura periodica dello storico: il canale lo
     * consegna subito, la query lo ritrova quindici secondi dopo. Senza deduplicazione l'operatore
     * vedrebbe ogni evento raddoppiato pochi secondi dopo averlo visto la prima volta.
     */
    const push: NotificationPush = {
      ...NOTHING,
      message: STORICO.message,
      occurredAt: STORICO.occurredAt,
      robotaxiId: 'RT-07',
      zoneId: 'san-siro',
    };

    expect(mergeOperatorAlerts([STORICO], [push], 12)).toHaveLength(1);
  });

  it('tiene distinti due eventi con lo stesso istante', () => {
    /**
     * Il rischio opposto, e non è teorico: una scelta manuale cambia strategia **e** modo, e i due
     * eventi che ne nascono portano lo stesso `occurredAt`. Deduplicare sul solo istante ne farebbe
     * sparire uno — cioè il difetto che questa correzione doveva chiudere, reintrodotto dalla
     * correzione stessa.
     */
    const istante = '2026-05-04T19:31:00.000Z';
    const strategia: NotificationPush = {
      ...NOTHING,
      occurredAt: istante,
      message: 'Il sistema è passato alla strategia ETA minimo.',
      strategy: 'MINIMUM_ETA',
      mode: 'MANUAL',
    };
    const modo: NotificationPush = {
      ...NOTHING,
      occurredAt: istante,
      message: 'Il sistema è passato in modo Manual: resta attiva la strategia ETA minimo.',
      strategy: 'MINIMUM_ETA',
      mode: 'MANUAL',
    };

    expect(mergeOperatorAlerts([], [strategia, modo], 12)).toHaveLength(2);
  });

  it('ordina dal più recente, qualunque sia la sorgente', () => {
    const recente: NotificationPush = {
      ...NOTHING,
      occurredAt: '2026-05-04T19:35:00.000Z',
      message: 'Traffico HIGH: il sistema è passato a ETA minimo.',
      trafficLevel: 'HIGH',
    };

    const merged = mergeOperatorAlerts([STORICO], [recente], 12);

    expect(merged.map((entry) => entry.occurredAt)).toEqual([
      '2026-05-04T19:35:00.000Z',
      STORICO.occurredAt,
    ]);
  });

  it('scarta dalla diretta ciò che non è un alert', () => {
    /**
     * Il canale porta all'operatore **tutto** ciò che non è un evento di corsa, transizioni dei
     * veicoli comprese: quelle si guardano sulla mappa e nel log operativo, non qui. Senza il
     * filtro il pannello si riempirebbe di movimenti e gli switch di strategia ci si perderebbero
     * dentro — che è il difetto opposto a quello che stiamo correggendo.
     */
    const transizione: NotificationPush = {
      ...NOTHING,
      message: 'Il robotaxi RT-03 è tornato disponibile.',
      robotaxiId: 'RT-03',
      robotaxiState: 'AVAILABLE',
    };

    expect(mergeOperatorAlerts([], [transizione], 12)).toHaveLength(0);
  });

  it('non supera il limite di righe', () => {
    const molti = Array.from({ length: 30 }, (_, index) => ({
      ...NOTHING,
      occurredAt: `2026-05-04T19:${String(index).padStart(2, '0')}:00.000Z`,
      message: `Traffico HIGH numero ${index}.`,
      trafficLevel: 'HIGH' as const,
    }));

    expect(mergeOperatorAlerts([], molti, 12)).toHaveLength(12);
  });
});
