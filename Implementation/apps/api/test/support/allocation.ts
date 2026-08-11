import { Test, type TestingModule } from '@nestjs/testing';
import { DEFAULT_STRATEGY, type GeoPoint, type StrategyName } from '@road/shared';

import { AllocationModule } from '../../src/allocation/allocation.module';
import {
  ALLOCATION_STRATEGIES,
  AllocationPort,
  type AllocationStrategy,
} from '../../src/allocation/allocation.port';
import {
  ExternalServicesPort,
  type EtaEstimate,
  type EtaOrigin,
} from '../../src/external/external-services.port';
import {
  PersistencePort,
  RecordNotFoundError,
  SYSTEM_MODE_ID,
  type EntityKind,
  type PersistedRecord,
  type RecordPatch,
  type SystemModeRecord,
} from '../../src/persistence/persistence.port';
import { ClockPort } from '../../src/platform/clock.port';
import { FakeClock } from '../../src/platform/fake-clock';

/**
 * Il modulo `allocation` composto **senza database e senza rete**, per i test che riguardano la
 * scelta del veicolo (M3).
 *
 * Perché qui i doppi sono la scelta giusta, mentre in M1 e M2 non lo erano: il cancello di M1
 * verifica un vincolo di esclusione che è una funzione di PostgreSQL, e quello di M2 che lo stato
 * sopravvive a un giro di persistenza — su un finto si verificherebbe il finto. Ciò che M3 deve
 * dimostrare è invece quale veicolo viene scelto date una metrica e una lista di candidati: una
 * proprietà del dominio, che un database renderebbe solo più lenta da provare. La scrittura *vera*
 * della strategia sul record `system_mode` resta verificata su Postgres, nei test di integrazione e
 * nella parte HTTP del cancello.
 *
 * Il modulo si raggiunge solo dalle sue porte (CLAUDE.md Regola 1): questo file inietta
 * `AllocationPort` e sostituisce `PersistencePort`, `ExternalServicesPort` e `ClockPort`, che sono
 * porte anch'esse. Nessun test conosce `AllocationManager` né le due strategie concrete — le
 * riconosce dal comportamento, che è il solo modo per cui riscrivere il modulo non costringerebbe a
 * riscriverne i test (HARNESS.md §9).
 */

/**
 * Il doppio di `PersistencePort` che sa fare una cosa sola: custodire il record `system_mode`.
 *
 * È l'unica tabella che `allocation` tocca — legge la strategia attiva, la riscrive — e ogni altra
 * operazione fallisce di proposito con un messaggio esplicito: se un giorno il manager cominciasse
 * a scrivere altro, i test lo direbbero invece di ignorarlo.
 */
export class SystemModeDouble extends PersistencePort {
  private record: SystemModeRecord | null;

  constructor(activeStrategy: StrategyName = DEFAULT_STRATEGY, updatedAt = new Date(0)) {
    super();
    this.record = {
      id: SYSTEM_MODE_ID,
      activeStrategy,
      mode: 'AUTO',
      lastTrafficLevel: null,
      updatedAt,
    };
  }

  /** Il record com'è adesso: serve alle asserzioni su cosa è stato scritto. */
  get systemMode(): SystemModeRecord | null {
    return this.record;
  }

  /**
   * Toglie di mezzo la riga singleton, per il caso in cui il database non è quello che il sistema
   * si aspetta: è l'unico modo di far vedere `SystemModeNotInitialisedError`, che su Postgres non
   * si raggiunge perché quella riga nasce con la migrazione iniziale e il suo `id` è vincolato.
   */
  forgetSystemMode(): void {
    this.record = null;
  }

  /**
   * Mette in colonna un nome di strategia **qualunque**, anche uno che `StrategyName` non prevede.
   *
   * Serve a un caso solo, quello di NFR7: registrare una terza politica inventata e verificare che
   * il manager la esegua senza essere stato modificato. La conversione di tipo sta qui, in un
   * metodo che la spiega, invece di sparpagliarsi nei test — e ciò che la rende necessaria è un
   * fatto vero del sistema, non un difetto: una politica *reale* in più richiede il suo nome in
   * `STRATEGY_NAMES` e una migrazione della colonna `system_mode.active_strategy`, che da quella
   * tupla ha generato il proprio vincolo `CHECK`. Nessuna delle due tocca la logica di allocazione.
   */
  forceActiveStrategy(name: string): void {
    if (this.record === null) throw new Error('La riga singleton è stata tolta dal test.');
    this.record = { ...this.record, activeStrategy: name as StrategyName };
  }

  override create<K extends EntityKind>(kind: K): Promise<PersistedRecord<K>> {
    return Promise.reject(new Error(`Il doppio di PersistencePort non scrive "${kind}".`));
  }

  override update<K extends EntityKind>(
    kind: K,
    id: string,
    patch: RecordPatch<K>,
  ): Promise<PersistedRecord<K>> {
    if (kind !== 'system_mode' || id !== SYSTEM_MODE_ID || this.record === null) {
      return Promise.reject(new RecordNotFoundError(kind, id));
    }

    this.record = { ...this.record, ...(patch as RecordPatch<'system_mode'>) };
    return Promise.resolve(this.asRecordOf<K>(this.record));
  }

  override find<K extends EntityKind>(kind: K): Promise<PersistedRecord<K>[]> {
    if (kind !== 'system_mode' || this.record === null) return Promise.resolve([]);
    return Promise.resolve([this.asRecordOf<K>(this.record)]);
  }

  override filterAvailable(): Promise<string[]> {
    return Promise.reject(new Error('Il doppio di PersistencePort non filtra la timeline.'));
  }

  override reserve(): Promise<never> {
    return Promise.reject(new Error('Il doppio di PersistencePort non scrive riserve.'));
  }

  /**
   * L'unica conversione di tipo del doppio, isolata in un punto.
   *
   * `PersistencePort` è generica sul registro dei tipi persistiti, e un doppio che ne conosce una
   * sola voce non può dimostrare al compilatore che `K` è proprio quella: il controllo su `kind`
   * l'ha già fatto chi chiama questo metodo, una riga sopra.
   */
  private asRecordOf<K extends EntityKind>(record: SystemModeRecord): PersistedRecord<K> {
    return record as unknown as PersistedRecord<K>;
  }
}

/**
 * Il doppio di `ExternalServicesPort`: una tabella di ETA fissi, per identificatore di veicolo.
 *
 * Un veicolo assente dalla tabella è un veicolo di cui il fornitore **non sa dire** l'ETA, e non un
 * veicolo con ETA zero: è la distinzione che rende `MinimumEtaStrategy` capace di scartarlo.
 *
 * Registra le chiamate ricevute, perché una parte di ciò che c'è da verificare è *cosa* viene
 * chiesto: gli ETA vanno chiesti verso il punto di prelievo, e in una sola chiamata per tutti i
 * candidati (DD §2.4, Figura 2.5).
 */
export class EtaTableDouble extends ExternalServicesPort {
  readonly calls: Array<{ origins: readonly EtaOrigin[]; destination: GeoPoint }> = [];

  constructor(private minutesById: Readonly<Record<string, number>> = {}) {
    super();
  }

  /** Cambia la tabella fra un caso e l'altro senza ricomporre il modulo. */
  setEta(minutesById: Readonly<Record<string, number>>): void {
    this.minutesById = minutesById;
  }

  getETA(origins: readonly EtaOrigin[], destination: GeoPoint): Promise<readonly EtaEstimate[]> {
    this.calls.push({ origins, destination });

    return Promise.resolve(
      origins.flatMap((origin): EtaEstimate[] => {
        const etaMinutes = this.minutesById[origin.id];
        return etaMinutes === undefined ? [] : [{ id: origin.id, etaMinutes }];
      }),
    );
  }
}

export interface AllocationHarness {
  readonly allocation: AllocationPort;
  readonly systemMode: SystemModeDouble;
  readonly external: EtaTableDouble;
  readonly clock: FakeClock;
  /** I nomi delle strategie registrate, nell'ordine in cui il modulo le fornisce. */
  readonly registeredStrategies: readonly string[];
  close(): Promise<void>;
}

export interface ComposeOptions {
  readonly activeStrategy?: StrategyName;
  readonly etaMinutes?: Readonly<Record<string, number>>;
  readonly now?: Date;
  /**
   * Politiche **aggiuntive** rispetto a quelle registrate da `allocation.module.ts`.
   *
   * È la «registrazione» di NFR7 vista dal test, e va detto con precisione cosa fa: **sostituisce
   * il provider del registro** con le politiche del modulo più quelle passate qui. Non esegue la
   * riga che in produzione si aggiunge all'elenco `STRATEGIES` di `allocation.module.ts` — quella
   * riga non è eseguibile da un test senza esporre un punto di estensione che il DD non prevede.
   * Ciò che resta dimostrato per intero è la parte di NFR7 che conta: la classe è scritta fuori dal
   * modulo estendendo la sola classe astratta pubblicata, e il manager la esegue senza essere stato
   * modificato.
   */
  readonly extraStrategies?: readonly AllocationStrategy[];
}

export async function composeAllocation(options: ComposeOptions = {}): Promise<AllocationHarness> {
  const systemMode = new SystemModeDouble(options.activeStrategy);
  const external = new EtaTableDouble(options.etaMinutes);
  const clock = new FakeClock(options.now ?? new Date('2026-05-04T09:00:00.000Z'));
  const opened: TestingModule[] = [];

  const build = async (registry?: readonly AllocationStrategy[]): Promise<TestingModule> => {
    const builder = Test.createTestingModule({ imports: [AllocationModule] })
      .overrideProvider(PersistencePort)
      .useValue(systemMode)
      .overrideProvider(ExternalServicesPort)
      .useValue(external)
      .overrideProvider(ClockPort)
      .useValue(clock);

    const moduleRef = await (
      registry === undefined
        ? builder
        : builder.overrideProvider(ALLOCATION_STRATEGIES).useValue([...registry])
    ).compile();

    opened.push(moduleRef);
    return moduleRef;
  };

  // La composizione di default dice quali politiche il modulo registra da sé. Le si legge invece
  // di elencarle qui: un test che ripetesse l'elenco resterebbe verde anche se il modulo ne
  // perdesse una.
  let moduleRef = await build();
  const builtIn = moduleRef.get<AllocationStrategy[]>(ALLOCATION_STRATEGIES);

  const extra = options.extraStrategies ?? [];
  if (extra.length > 0) {
    // Si ricompone aggiungendo le politiche del test a quelle del modulo. Gli oggetti costruiti
    // dalla prima composizione restano validi: dipendono dai doppi qui sopra, che sono gli stessi.
    moduleRef = await build([...builtIn, ...extra]);
  }

  const strategies = moduleRef.get<AllocationStrategy[]>(ALLOCATION_STRATEGIES);

  return {
    allocation: moduleRef.get(AllocationPort),
    systemMode,
    external,
    clock,
    registeredStrategies: strategies.map((strategy) => strategy.name),
    async close(): Promise<void> {
      for (const open of opened) await open.close();
    },
  };
}
