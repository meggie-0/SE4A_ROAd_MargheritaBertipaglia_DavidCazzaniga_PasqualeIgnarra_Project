import type { ControlMode, OperatorAlertKind, StrategyName, TrafficLevel } from '@road/shared';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

import type { OperatorAlertRecord } from '../persistence.port';

/**
 * `operator_alert` — lo storico degli avvisi sul **governo del sistema** (decisione D77).
 *
 * Sta accanto a `notification` e non dentro, ed è la sostanza della D77. La `Notification` del RASD
 * §2.2.3 è indirizzata a un passeggero — la Figura 2.2 la disegna `sent to "1" Passenger`, e la
 * colonna `recipient_id NOT NULL REFERENCES "user"` lo realizza — mentre questi quattro eventi non
 * hanno nessun passeggero a cui andare. Farli entrare in quella tabella avrebbe richiesto di rendere
 * opzionale la relazione che la figura dà per obbligatoria: una divergenza dal RASD scritta nello
 * schema, per giunta permanente.
 *
 * **Non c'è un destinatario, e non è un'omissione.** Un alert dell'operatore non è indirizzato a
 * nessuno in particolare: è una cosa che è successa al sistema, e la vede chiunque apra la
 * dashboard. È anche l'unica forma che funziona per uno *storico* — un operatore creato domani
 * ritrova ciò che è accaduto ieri, che con righe indirizzate a chi esisteva allora sarebbe perduto.
 */
@Entity({ name: 'operator_alert' })
@Index('operator_alert_occurred_idx', ['occurredAt'])
export class OperatorAlertEntity implements OperatorAlertRecord {
  @PrimaryColumn({ type: 'uuid' })
  id!: string;

  @Column({ type: 'varchar', length: 40 })
  kind!: OperatorAlertKind;

  /** Il testo composto da `notification-copy.ts`, lo stesso che il canale push ha consegnato. */
  @Column({ type: 'varchar', length: 500 })
  message!: string;

  /** L'istante del fatto, da `ClockPort`, non quello della scrittura. */
  @Column({ name: 'occurred_at', type: 'timestamptz' })
  occurredAt!: Date;

  @Column({ type: 'varchar', length: 40, nullable: true })
  strategy!: StrategyName | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  mode!: ControlMode | null;

  @Column({ name: 'traffic_level', type: 'varchar', length: 20, nullable: true })
  trafficLevel!: TrafficLevel | null;

  /**
   * Zona e veicolo sono **copie**, non chiavi esterne.
   *
   * Uno storico dice com'era il mondo allora. Una `REFERENCES zone` con `ON DELETE SET NULL`
   * perderebbe l'informazione il giorno in cui una zona sparisce, e una `CASCADE` cancellerebbe la
   * riga: in entrambi i casi il passato cambierebbe per un fatto del presente, che è il modo in cui
   * uno storico smette di essere tale. Sono gli unici due riferimenti del sistema tenuti così, e
   * questa è la ragione.
   */
  @Column({ name: 'zone_id', type: 'varchar', length: 64, nullable: true })
  zoneId!: string | null;

  @Column({ name: 'robotaxi_id', type: 'varchar', length: 64, nullable: true })
  robotaxiId!: string | null;
}
