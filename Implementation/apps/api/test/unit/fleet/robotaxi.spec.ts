import {
  IllegalTransitionError,
  Robotaxi,
  RobotaxiStateFactory,
  type RobotaxiSnapshot,
} from '../../../src/fleet/fleet-monitor.port';

/**
 * Il pattern State applicato al ciclo di vita del veicolo (DD §2.3.2 e §2.6.3, Figura 2.10).
 *
 * Qui si guarda il *meccanismo*: che ogni transizione legale porti dove la figura dice, che le
 * azioni `storeRide()` e `releaseRobotaxi()` avvengano, che la fabbrica ricostruisca il
 * comportamento dal solo nome dello stato. L'enumerazione esaustiva delle 63 combinazioni sta nel
 * cancello di M2, che è dove il criterio di completamento della milestone va tradotto in test.
 *
 * Tutto passa da `fleet-monitor.port.ts`: un test che raggiungesse `states/available.state.ts`
 * smetterebbe di dimostrare che il modulo è sostituibile (HARNESS.md §9), e `pnpm arch` lo rifiuta.
 */

const RIDE = { rideRequestId: 'ride-1' };

/** Un veicolo fermo al Duomo, nello stato indicato. */
function vehicleIn(
  state: RobotaxiSnapshot['state'],
  rideRequestId: string | null = null,
): Robotaxi {
  return new Robotaxi(
    {
      id: 'RT-01',
      state,
      lat: 45.4642,
      lon: 9.19,
      zoneId: 'duomo',
      updatedAt: new Date('2026-05-04T09:00:00.000Z'),
    },
    rideRequestId,
  );
}

describe('[NFR5][G6] Robotaxi state transitions', () => {
  describe('Le dieci transizioni legali della Figura 2.10', () => {
    it('1. AVAILABLE --requestMaintenance--> MAINTENANCE', () => {
      const robotaxi = vehicleIn('AVAILABLE');

      robotaxi.requestMaintenance();

      expect(robotaxi.currentState).toBe('MAINTENANCE');
    });

    it('2. MAINTENANCE --completeMaintenance--> AVAILABLE', () => {
      const robotaxi = vehicleIn('MAINTENANCE');

      robotaxi.completeMaintenance();

      expect(robotaxi.currentState).toBe('AVAILABLE');
    });

    it('3. AVAILABLE --assignRide--> ASSIGNED, memorizzando la corsa', () => {
      const robotaxi = vehicleIn('AVAILABLE');

      robotaxi.assignRide(RIDE);

      expect(robotaxi.currentState).toBe('ASSIGNED');
      // L'azione `storeRide()` della transizione: senza, `ASSIGNED` sarebbe uno stato senza corsa.
      expect(robotaxi.assignedRideRequestId).toBe('ride-1');
    });

    it('4. ASSIGNED --startPickupNavigation--> ARRIVING', () => {
      const robotaxi = vehicleIn('ASSIGNED', 'ride-1');

      robotaxi.startPickupNavigation();

      expect(robotaxi.currentState).toBe('ARRIVING');
    });

    it('5. ARRIVING --pickupReached--> ARRIVED', () => {
      const robotaxi = vehicleIn('ARRIVING', 'ride-1');

      robotaxi.pickupReached();

      expect(robotaxi.currentState).toBe('ARRIVED');
    });

    it('6. ARRIVED --startRide--> IN_RIDE', () => {
      const robotaxi = vehicleIn('ARRIVED', 'ride-1');

      robotaxi.startRide();

      expect(robotaxi.currentState).toBe('IN_RIDE');
    });

    it('7. IN_RIDE --completeRide--> AVAILABLE, liberando il veicolo', () => {
      const robotaxi = vehicleIn('IN_RIDE', 'ride-1');

      robotaxi.completeRide();

      expect(robotaxi.currentState).toBe('AVAILABLE');
      // L'azione `releaseRobotaxi()`: se la corsa restasse attaccata, il veicolo tornerebbe
      // disponibile portandosi dietro un impegno che non ha più.
      expect(robotaxi.assignedRideRequestId).toBeNull();
    });

    it('8. AVAILABLE --requestRebalancing--> REBALANCING', () => {
      const robotaxi = vehicleIn('AVAILABLE');

      robotaxi.requestRebalancing();

      expect(robotaxi.currentState).toBe('REBALANCING');
    });

    it('9. REBALANCING --completeRebalancing--> AVAILABLE', () => {
      const robotaxi = vehicleIn('REBALANCING');

      robotaxi.completeRebalancing();

      expect(robotaxi.currentState).toBe('AVAILABLE');
    });

    it('10. REBALANCING --assignRide--> ASSIGNED: il riposizionamento si interrompe', () => {
      const robotaxi = vehicleIn('REBALANCING');

      robotaxi.assignRide(RIDE);

      expect(robotaxi.currentState).toBe('ASSIGNED');
      expect(robotaxi.assignedRideRequestId).toBe('ride-1');
    });
  });

  describe('I due punti che il DD §2.6.3 segnala come facili da sbagliare', () => {
    it('un veicolo in rebalancing resta allocabile', () => {
      // Se `RebalancingState` non esponesse `assignRide()`, spostare i veicoli inattivi verso la
      // domanda prevista li renderebbe irraggiungibili proprio dove la domanda c'è (R11, G9).
      expect(() => vehicleIn('REBALANCING').assignRide(RIDE)).not.toThrow();
    });

    it('un veicolo in rebalancing non entra in manutenzione: ci passa da available', () => {
      expect(() => vehicleIn('REBALANCING').requestMaintenance()).toThrow(IllegalTransitionError);

      const robotaxi = vehicleIn('REBALANCING');
      robotaxi.completeRebalancing();
      robotaxi.requestMaintenance();

      expect(robotaxi.currentState).toBe('MAINTENANCE');
    });
  });

  describe("L'errore tipizzato", () => {
    it('dice quale transizione è stata rifiutata e da quale stato', () => {
      // Un errore che dicesse solo "transizione illegale" costringerebbe la dashboard a indovinare
      // cosa mostrare all'operatore.
      let caught: unknown;
      try {
        vehicleIn('MAINTENANCE').assignRide(RIDE);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IllegalTransitionError);
      expect(caught).toMatchObject({
        name: 'IllegalTransitionError',
        robotaxiId: 'RT-01',
        from: 'MAINTENANCE',
        transition: 'assignRide',
      });
    });

    it('lascia lo stato invariato: una transizione rifiutata non è una transizione a metà', () => {
      const robotaxi = vehicleIn('ARRIVING', 'ride-1');

      expect(() => robotaxi.startRide()).toThrow(IllegalTransitionError);

      expect(robotaxi.currentState).toBe('ARRIVING');
      expect(robotaxi.assignedRideRequestId).toBe('ride-1');
    });
  });

  describe('RobotaxiStateFactory', () => {
    it.each([
      'AVAILABLE',
      'ASSIGNED',
      'ARRIVING',
      'ARRIVED',
      'IN_RIDE',
      'REBALANCING',
      'MAINTENANCE',
    ] as const)('ricostruisce %s dal solo nome dello stato', (state) => {
      expect(RobotaxiStateFactory.forState(state).name).toBe(state);
    });

    it('restituisce una nuova istanza a ogni chiamata, come dice «rebuilt on each read»', () => {
      expect(RobotaxiStateFactory.forState('AVAILABLE')).not.toBe(
        RobotaxiStateFactory.forState('AVAILABLE'),
      );
    });

    it('ricostruisce il comportamento, non solo il nome', () => {
      // La prova che la colonna enum basta: un veicolo nato da `ARRIVED` sa fare `startRide()` e
      // non sa fare `assignRide()`, senza che nessuno gli abbia detto altro.
      const robotaxi = vehicleIn('ARRIVED', 'ride-1');

      expect(() => robotaxi.assignRide(RIDE)).toThrow(IllegalTransitionError);
      robotaxi.startRide();

      expect(robotaxi.currentState).toBe('IN_RIDE');
    });

    it('lo snapshot riflette lo stato corrente, ed è ciò che viene persistito', () => {
      const robotaxi = vehicleIn('AVAILABLE');

      robotaxi.requestRebalancing();

      expect(robotaxi.toSnapshot()).toMatchObject({ id: 'RT-01', state: 'REBALANCING' });
    });
  });
});
