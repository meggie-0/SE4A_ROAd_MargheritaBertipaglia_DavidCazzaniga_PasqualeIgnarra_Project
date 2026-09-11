import type { DomainEvent } from '../../../src/notifications/notification.port';
import {
  composeNotifications,
  recordOperator,
  recordPassenger,
  type NotificationsHarness,
} from '../../support/notifications';

/**
 * La riga del registro operativo che spiega un'assegnazione (decisione D79).
 *
 * Due proprietà, e la seconda conta quanto la prima. La prima è il testo: dice con quale strategia,
 * con che tempo, e — quando la strategia non ha scelto il più vicino — quanto ci avrebbe messo lui.
 * La seconda è che **non è altro che testo**: nessun campo strutturato, quindi nessuna riga di
 * storico, nessun passeggero raggiunto, nessun alert e nessuno spostamento del pannello strategia.
 * Un evento che portasse `strategy` sarebbe classificato come una commutazione dalla dashboard, e
 * con cinquanta assegnazioni in tre minuti il pannello alert non mostrerebbe più altro.
 *
 * Si passa dalla porta, come negli altri casi dell'instradamento: `notification-copy.ts` è interno
 * al modulo, e ciò che conta è la consegna che la dashboard riceve.
 */

const AT = new Date('2026-05-04T09:15:00.000Z');

let harness: NotificationsHarness;

beforeEach(async () => {
  harness = await composeNotifications(AT);
});

afterEach(async () => {
  await harness.close();
});

function allocated(
  strategy: 'NEAREST_AVAILABLE' | 'MINIMUM_ETA',
  etaMinutes: number,
  nearest: { robotaxiId: string; etaMinutes: number } | null,
): DomainEvent {
  return {
    kind: 'VEHICLE_ALLOCATED',
    occurredAt: AT,
    robotaxiId: 'RT-22',
    strategy,
    etaMinutes,
    nearest,
  };
}

describe('[R5][R7][R8] Ogni assegnazione dice all’operatore perché quel veicolo', () => {
  it('quando ETA minimo non sceglie il più vicino, dice quanto ci avrebbe messo lui', async () => {
    const dashboard = recordOperator(harness.sessions);

    await harness.notifications.update(
      allocated('MINIMUM_ETA', 9.26, { robotaxiId: 'RT-06', etaMinutes: 10.54 }),
    );

    expect(dashboard.received.map((one) => one.message)).toEqual([
      'RT-22 assegnato con ETA minimo, 9,3 min — il più vicino, RT-06, ne avrebbe impiegati 10,5',
    ]);
  });

  it('quando ETA minimo sceglie proprio il più vicino, lo dice', async () => {
    const dashboard = recordOperator(harness.sessions);

    await harness.notifications.update(allocated('MINIMUM_ETA', 4.2, null));

    expect(dashboard.received[0]?.message).toBe(
      'RT-22 assegnato con ETA minimo, 4,2 min — è anche il più vicino',
    );
  });

  it('con Più vicino disponibile non c’è nessun confronto da fare', async () => {
    const dashboard = recordOperator(harness.sessions);

    await harness.notifications.update(allocated('NEAREST_AVAILABLE', 4.2, null));

    expect(dashboard.received[0]?.message).toBe(
      'RT-22 assegnato con Più vicino disponibile, 4,2 min',
    );
  });
});

describe('[R12][R13] La spiegazione è solo testo: non è un alert e non muove lo schermo', () => {
  it('nessun campo strutturato tranne il veicolo, che il registro rende cliccabile', async () => {
    const dashboard = recordOperator(harness.sessions);

    await harness.notifications.update(
      allocated('MINIMUM_ETA', 9.26, { robotaxiId: 'RT-06', etaMinutes: 10.54 }),
    );

    // `strategy` in particolare: la dashboard classifica come commutazione qualunque evento che la
    // porti, e ne riscrive il pannello strategia.
    expect(dashboard.received[0]).toMatchObject({
      type: null,
      robotaxiId: 'RT-22',
      robotaxiState: null,
      rideRequestId: null,
      rideStatus: null,
      strategy: null,
      mode: null,
      trafficLevel: null,
      zoneId: null,
      etaMinutes: null,
    });
  });

  it('non raggiunge nessun passeggero', async () => {
    const giulia = recordPassenger(harness.sessions, 'passeggero-giulia');

    await harness.notifications.update(allocated('MINIMUM_ETA', 9.26, null));

    expect(giulia.received).toEqual([]);
  });

  it('non lascia righe né nello storico del passeggero né in quello degli alert della D77', async () => {
    await harness.notifications.update(
      allocated('MINIMUM_ETA', 9.26, { robotaxiId: 'RT-06', etaMinutes: 10.54 }),
    );

    // Lo storico degli alert resta i quattro eventi di governo: un'assegnazione non è una decisione
    // sul governo del sistema, e cinquanta righe in tre minuti seppellirebbero quelle che lo sono.
    expect(harness.persistence.rowsOf('notification')).toEqual([]);
    expect(harness.persistence.rowsOf('operator_alert')).toEqual([]);

    // Il controllo che rende l'asserzione qui sopra non vuota: nello stesso harness un evento di
    // governo la sua riga la lascia.
    await harness.notifications.update({
      kind: 'TRAFFIC_ALERT',
      occurredAt: AT,
      trafficLevel: 'MEDIUM',
      suggestedStrategy: 'MINIMUM_ETA',
    });
    expect(harness.persistence.rowsOf('operator_alert')).toHaveLength(1);
  });
});
