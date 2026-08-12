import { Injectable, Logger } from '@nestjs/common';
import type { ControlMode, StrategyName, TrafficLevel } from '@road/shared';

import { AllocationPort, SystemModeNotInitialisedError } from '../allocation/allocation.port';
import { NotificationPort } from '../notifications/notification.port';
import {
  PersistencePort,
  StaleRecordError,
  SYSTEM_MODE_ID,
  type SystemModeRecord,
} from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import { ModePort, STRATEGY_BY_TRAFFIC, SUGGESTED_ON_MEDIUM } from './mode.port';

/**
 * Il `ModeController` (DD §2.2, §2.4 Figura 2.6): l'isteresi e la precedenza dell'intervento umano.
 *
 * Tutto ciò che questa classe decide sta in `applySwitch()`, sei righe, e la tabella
 * `STRATEGY_BY_TRAFFIC` che consulta. È voluto: R12, R13, NFR9 e NFR10 sono quattro requisiti che
 * parlano della stessa decisione da quattro punti di vista, e se la decisione fosse sparsa fra i
 * metodi pubblici ognuno dei quattro andrebbe verificato su un ramo diverso. Così `onTrafficLevel()`
 * e `enableAuto()` — i due ingressi che possono commutare — passano dallo **stesso** punto, che è
 * anche il modo in cui la decisione D11 è vera per costruzione invece che per ripetizione: rientrare
 * in Auto rivaluta l'ultimo livello con la medesima tabella con cui lo si sarebbe valutato allora.
 *
 * Non tiene stato. `autoMode` e `currentTrafficLevel`, che la Figura 2.2 disegna come attributi,
 * sono due colonne di `system_mode` (decisioni D6 e D20): con più repliche del tier applicativo
 * (NFR3) un valore in memoria divergerebbe alla prima lettura di traffico gestita da un'altra
 * istanza, e la dashboard mostrerebbe un modo diverso da quello con cui il sistema sta allocando.
 */
@Injectable()
export class ModeController extends ModePort {
  private readonly logger = new Logger(ModeController.name);

  constructor(
    private readonly persistence: PersistencePort,
    /**
     * L'arco `ModeController → AllocationManager` della Figura 2.1: l'unico scrittore della
     * strategia attiva sta di là, e questo componente decide soltanto quando chiamarlo.
     */
    private readonly allocation: AllocationPort,
    private readonly notifications: NotificationPort,
    private readonly clock: ClockPort,
  ) {
    super();
  }

  async onTrafficLevel(level: TrafficLevel): Promise<void> {
    const before = await this.systemMode();

    /**
     * Il livello si registra **sempre**, modo Manual compreso (decisione D20).
     *
     * È la condizione perché `enableAuto()` possa rivalutare «l'ultimo livello noto» (decisione
     * D11): se durante il modo Manual le letture non lasciassero traccia, un operatore che
     * riabilita Auto dopo un'ora rivaluterebbe il traffico di un'ora prima, e il sistema
     * commuterebbe in base a una condizione che non c'è più.
     */
    await this.persistence.update('system_mode', SYSTEM_MODE_ID, { lastTrafficLevel: level });

    // R13, NFR10: in modo Manual nessuno switch automatico avviene, qualunque sia il livello.
    if (before.mode === 'MANUAL') return;

    /**
     * L'alert della soglia intermedia si emette **quando la si raggiunge**, non a ogni lettura.
     *
     * R12 dice «if traffic conditions *reach* a Medium threshold»: è un passaggio di soglia, non
     * uno stato. Il `TrafficMonitor` legge il traffico ogni pochi minuti, quindi ripeterlo a ogni
     * lettura riempirebbe il pannello dell'operatore con la stessa riga per tutta la durata della
     * condizione — e un pannello che si riempie da solo è un pannello che si smette di guardare.
     */
    if (level === 'MEDIUM' && before.lastTrafficLevel !== 'MEDIUM') {
      await this.notifications.update({
        kind: 'TRAFFIC_ALERT',
        occurredAt: this.clock.now(),
        trafficLevel: level,
        suggestedStrategy: SUGGESTED_ON_MEDIUM,
      });
    }

    await this.applySwitch(level, before.activeStrategy);
  }

  async setManual(name: StrategyName): Promise<void> {
    // Strategia e modo in una sola scrittura, dentro `allocation` (NFR10). Qui non c'è nessuna
    // condizione da verificare prima: la scelta di un essere umano ha la precedenza su qualunque
    // cosa il sistema stesse per fare, ed è letteralmente ciò che NFR10 chiede.
    await this.allocation.setActiveStrategy(name, 'manual');
    const level = (await this.systemMode()).lastTrafficLevel;

    await this.announce(name, 'MANUAL', 'manual', level);
  }

  async enableAuto(): Promise<void> {
    const before = await this.systemMode();

    // La sola scrittura che riporta il modo ad Auto in tutto il sistema (DD §2.2.1).
    if (before.mode !== 'AUTO') {
      await this.persistence.update('system_mode', SYSTEM_MODE_ID, { mode: 'AUTO' });
    }

    /**
     * La rivalutazione immediata della decisione D11.
     *
     * `lastTrafficLevel` nullo significa che nessuna lettura è ancora arrivata — il sistema è
     * appena partito — e allora non c'è niente da rivalutare: si resta sulla strategia corrente e
     * si commuterà alla prima lettura. Su `MEDIUM` `applySwitch()` non fa nulla di proposito, che
     * è la frase del RASD R13 «should the level be Medium […] the strategy active at that instant
     * is kept» realizzata dalla stessa tabella e non da un ramo scritto a parte.
     */
    const switched =
      before.lastTrafficLevel === null
        ? false
        : await this.applySwitch(before.lastTrafficLevel, before.activeStrategy);

    // Se la rivalutazione ha commutato, l'annuncio l'ha già fatto `applySwitch()`. Altrimenti c'è
    // comunque una cosa che le altre dashboard devono sapere: il sistema è tornato in Auto.
    if (!switched && before.mode !== 'AUTO') {
      await this.announce(before.activeStrategy, 'AUTO', 'auto', before.lastTrafficLevel);
    }
  }

  async getMode(): Promise<ControlMode> {
    return (await this.systemMode()).mode;
  }

  /**
   * La regola di isteresi, in un posto solo (DD §2.4; R12, NFR9).
   *
   * Restituisce se ha commutato. Tre motivi per non commutare, e nessuno è un errore: il livello
   * sta nella banda morta (`MEDIUM` non è nella tabella), la strategia che gli compete è già
   * attiva, oppure un operatore è passato in Manual fra la lettura e la scrittura.
   *
   * Il terzo caso merita attenzione. `setActiveStrategy(name, 'auto')` scrive **condizionatamente**
   * al modo Auto: se nel frattempo qualcuno ha scelto a mano, la scrittura non avviene e la
   * chiamata solleva `StaleRecordError`. Qui la si assorbe invece di propagarla, perché non è un
   * guasto — è NFR10 che ha funzionato. Propagarla farebbe fallire un'esecuzione periodica per una
   * decisione umana perfettamente legittima.
   */
  private async applySwitch(level: TrafficLevel, activeStrategy: StrategyName): Promise<boolean> {
    const target = STRATEGY_BY_TRAFFIC[level];
    if (target === undefined || target === activeStrategy) return false;

    try {
      await this.allocation.setActiveStrategy(target, 'auto');
    } catch (error) {
      if (error instanceof StaleRecordError) {
        this.logger.log(
          `Cambio automatico a ${target} annullato: il sistema è passato in modo Manual (NFR10).`,
        );
        return false;
      }
      throw error;
    }

    await this.announce(target, 'AUTO', 'auto', level);
    return true;
  }

  /**
   * L'evento della Figura 2.6 verso il `NotificationManager`.
   *
   * `ModeController` **non** è un `Subject` dell'Observer e non deve diventarlo: la Figura 2.6 lo
   * disegna mentre chiama `update(...)` direttamente sull'observer, che è la relazione giusta —
   * soggetto è chi ha uno stato che gli altri osservano, e qui c'è una decisione che va comunicata
   * una volta sola a chi la deve sapere.
   *
   * Si notifica **dopo** aver scritto, come per ogni altra transizione del sistema (decisione D39):
   * si racconta ciò che è successo, non ciò che si stava per fare.
   */
  private async announce(
    strategy: StrategyName,
    mode: ControlMode,
    source: 'auto' | 'manual',
    trafficLevel: TrafficLevel | null,
  ): Promise<void> {
    await this.notifications.update({
      kind: 'STRATEGY_CHANGED',
      occurredAt: this.clock.now(),
      strategy,
      mode,
      source,
      trafficLevel,
    });
  }

  /** Il record singleton, che porta insieme strategia, modo e ultimo livello noto (decisione D6). */
  private async systemMode(): Promise<SystemModeRecord> {
    const [record] = await this.persistence.find('system_mode', {
      where: { id: SYSTEM_MODE_ID },
      limit: 1,
    });
    if (record === undefined) throw new SystemModeNotInitialisedError();
    return record;
  }
}
