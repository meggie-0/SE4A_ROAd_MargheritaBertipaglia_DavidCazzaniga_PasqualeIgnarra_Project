import { Inject, Injectable } from '@nestjs/common';
import type { StrategyName } from '@road/shared';

import type { RobotaxiSnapshot } from '../fleet/robotaxi.port';
import { PersistencePort, SYSTEM_MODE_ID } from '../persistence/persistence.port';

import type { AllocationRequest, AllocationStrategy } from './allocation-strategy';
import {
  ALLOCATION_STRATEGIES,
  AllocationPort,
  SystemModeNotInitialisedError,
  UnknownStrategyError,
  type ChangeSource,
} from './allocation.port';

/**
 * Il **contesto** del pattern Strategy (DD §2.3.1 Figura 2.2, §2.6.1).
 *
 * Tutto ciò che questa classe fa è: leggere quale strategia è attiva, trovarla nel registro,
 * delegarle la scelta. Non c'è una riga di metrica qui dentro, non c'è uno `switch` sul nome della
 * strategia, e **non compare il nome di nessuna classe concreta** — cercare
 * `NearestAvailableStrategy` in questo file non dà risultati, ed è la forma verificabile di NFR7
 * («una politica nuova si aggiunge scrivendo una classe e registrandola, senza modificare
 * `AllocationManager` né `RideRequestManager`», DD §4.3).
 *
 * Il registro arriva da `allocation.module.ts`, dove le strategie disponibili sono elencate in un
 * posto solo. Il manager le indicizza per il nome che ognuna dichiara, e la strategia *attiva* la
 * risolve per nome a ogni chiamata: non ne tiene un riferimento, perché sarebbe una seconda copia
 * di un valore la cui sede autorevole è il record `system_mode` (DD §2.2.1, decisioni D6 e D26).
 *
 * Non dipende da `ClockPort`, e non è una dimenticanza: la data dell'ultima modifica la mette
 * `PersistenceManager` su ogni riga che ha quella colonna, dallo stesso orologio. Scriverla anche
 * qui sarebbe la stessa responsabilità in due posti, e il DD §2.2.1 dà a questo componente due sole
 * dipendenze — `ExternalServicesGateway` e `PersistenceManager`.
 */
@Injectable()
export class AllocationManager extends AllocationPort {
  private readonly strategies: ReadonlyMap<StrategyName, AllocationStrategy>;

  constructor(
    @Inject(ALLOCATION_STRATEGIES) strategies: readonly AllocationStrategy[],
    private readonly persistence: PersistencePort,
  ) {
    super();

    const byName = new Map<StrategyName, AllocationStrategy>();
    for (const strategy of strategies) {
      // Due strategie registrate con lo stesso nome sarebbero un errore di composizione silenzioso:
      // una delle due non verrebbe mai scelta, e quale delle due dipenderebbe dall'ordine
      // dell'elenco. Meglio non far partire l'applicazione.
      if (byName.has(strategy.name)) {
        throw new Error(`Due strategie di allocazione registrate con il nome ${strategy.name}.`);
      }
      byName.set(strategy.name, strategy);
    }
    this.strategies = byName;
  }

  async allocate(
    request: AllocationRequest,
    candidates: readonly RobotaxiSnapshot[],
  ): Promise<RobotaxiSnapshot | null> {
    const strategy = await this.activeStrategy();
    return strategy.selectRobotaxi(request, candidates);
  }

  async setActiveStrategy(name: StrategyName, source: ChangeSource): Promise<void> {
    // Il controllo precede la scrittura: senza, la colonna potrebbe finire su un nome che nessuna
    // classe realizza, e il sistema resterebbe con una strategia attiva impossibile da eseguire —
    // un guasto che si manifesterebbe alla prima allocazione, lontano da chi l'ha causato.
    if (!this.strategies.has(name)) throw new UnknownStrategyError(name);

    /**
     * Una sola `UPDATE`, quindi atomica per costruzione: con `source: 'manual'` non esiste
     * interleaving che lasci la strategia manuale scritta e il modo ancora su Auto, che è la
     * condizione con cui NFR10 si falsifica (DD §4.3).
     */
    await this.persistence.update('system_mode', SYSTEM_MODE_ID, {
      activeStrategy: name,
      ...(source === 'manual' ? { mode: 'MANUAL' as const } : {}),
    });
  }

  async getActiveStrategy(): Promise<StrategyName> {
    const [record] = await this.persistence.find('system_mode', {
      where: { id: SYSTEM_MODE_ID },
      limit: 1,
    });
    if (record === undefined) throw new SystemModeNotInitialisedError();
    return record.activeStrategy;
  }

  /** L'oggetto strategia attivo. Solleva se la colonna porta un nome non registrato. */
  private async activeStrategy(): Promise<AllocationStrategy> {
    const name = await this.getActiveStrategy();
    const strategy = this.strategies.get(name);
    if (strategy === undefined) throw new UnknownStrategyError(name);
    return strategy;
  }
}
