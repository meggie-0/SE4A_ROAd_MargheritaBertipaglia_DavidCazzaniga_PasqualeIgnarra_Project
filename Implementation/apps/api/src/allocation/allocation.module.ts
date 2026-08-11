import { Module, type Provider } from '@nestjs/common';

import { ExternalModule } from '../external/external.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import type { AllocationStrategy } from './allocation-strategy';
import { ALLOCATION_STRATEGIES, AllocationPort } from './allocation.port';
import { AllocationManager } from './allocation.manager';
import { MinimumEtaStrategy } from './strategies/minimum-eta.strategy';
import { NearestAvailableStrategy } from './strategies/nearest-available.strategy';

/**
 * **L'elenco delle politiche di allocazione disponibili.**
 *
 * È il "registro" di cui parla NFR7: una politica nuova è una classe nuova più una riga qui, e
 * nient'altro — nessuna modifica ad `AllocationManager`, che le riceve tutte insieme e le indicizza
 * per il nome che ognuna dichiara, né a `RideRequestManager`, che passa da `AllocationPort`.
 *
 * (Una politica *realmente* nuova ha un costo in più, e va detto: il suo nome deve entrare in
 * `STRATEGY_NAMES` di `packages/shared`, da cui la migrazione di M1 ha generato il vincolo `CHECK`
 * sulla colonna `system_mode.active_strategy`, e la colonna va migrata. È il prezzo di avere un
 * database che convalida i propri dati invece di fidarsi del codice; nessuna delle due modifiche
 * tocca la logica di allocazione.)
 */
const STRATEGIES = [NearestAvailableStrategy, MinimumEtaStrategy];

/**
 * Il registro, costruito da Nest istanziando ogni strategia e raccogliendole in un elenco.
 *
 * `inject` prende le stesse classi di `STRATEGIES`, quindi le due liste non possono divergere.
 */
const strategyRegistry: Provider = {
  provide: ALLOCATION_STRATEGIES,
  useFactory: (...strategies: AllocationStrategy[]): AllocationStrategy[] => strategies,
  inject: [...STRATEGIES],
};

/**
 * Il modulo `allocation` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **solo** `AllocationPort`. Le due strategie concrete restano dentro: si scelgono per
 * nome, che è ciò che permette all'operatore di cambiarle a runtime (R8) senza che nessun
 * chiamante conosca le classi.
 *
 * **Non importa `FleetModule`**, ed è una regola del DD §2.2.1 e non una dimenticanza: i candidati
 * glieli passa `rides` dentro `allocate()`, dopo averli chiesti a `FleetMonitor.getCandidates()`.
 * Aggiungere quell'arco renderebbe l'allocazione dipendente dalla flotta e ogni strategia
 * impossibile da provare con un semplice elenco di veicoli.
 */
/*
 * `PlatformModule` è fra gli `imports` perché è la forma che CLAUDE.md Regola 1 prescrive per
 * questo modulo, ma oggi nessun provider di `allocation` inietta `ClockPort` o `RandomPort`: la
 * data dell'ultima modifica di `system_mode` la mette `PersistenceManager`, dallo stesso orologio.
 * Se resterà inutilizzato anche dopo M6, va tolto da qui e dalla Regola 1 nella stessa occasione.
 */
@Module({
  imports: [ExternalModule, PersistenceModule, PlatformModule],
  providers: [
    ...STRATEGIES,
    strategyRegistry,
    { provide: AllocationPort, useClass: AllocationManager },
  ],
  exports: [AllocationPort], // SOLO la porta
})
export class AllocationModule {}
