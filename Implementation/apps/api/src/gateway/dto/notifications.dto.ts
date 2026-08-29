import { ApiProperty } from '@nestjs/swagger';
import {
  CONTROL_MODES,
  OPERATOR_ALERT_KINDS,
  STRATEGY_NAMES,
  TRAFFIC_LEVELS,
  type ControlMode,
  type OperatorAlert,
  type OperatorAlertKind,
  type OperatorAlertsResponse,
  type StrategyName,
  type TrafficLevel,
} from '@road/shared';

/**
 * I DTO dello storico degli alert dell'operatore (decisione D77).
 *
 * `implements` i tipi di `packages/shared` come tutti gli altri: se lo schema Zod e questa classe
 * divergessero, il compilatore lo direbbe prima che il contratto pubblicato mentisse ai client.
 */

export class OperatorAlertDto implements OperatorAlert {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    enum: OPERATOR_ALERT_KINDS,
    description:
      "La categoria dell'alert. Insieme distinto da `NotificationType`: quelli sono indirizzati a " +
      'un passeggero, questi al governo del sistema e a nessuno in particolare (decisione D77).',
  })
  kind!: OperatorAlertKind;

  @ApiProperty({
    example: 'Traffico MEDIUM: valutare il passaggio alla strategia ETA minimo.',
    description: 'Il testo già pronto, lo stesso che il canale push ha consegnato.',
  })
  message!: string;

  @ApiProperty({
    format: 'date-time',
    description: "L'istante del fatto, non quello della scrittura.",
  })
  occurredAt!: string;

  @ApiProperty({ enum: STRATEGY_NAMES, nullable: true })
  strategy!: StrategyName | null;

  @ApiProperty({ enum: CONTROL_MODES, nullable: true })
  mode!: ControlMode | null;

  @ApiProperty({ enum: TRAFFIC_LEVELS, nullable: true })
  trafficLevel!: TrafficLevel | null;

  @ApiProperty({
    nullable: true,
    example: 'san-siro',
    description: 'La zona verso cui un riposizionamento è partito. Copia, non riferimento.',
  })
  zoneId!: string | null;

  @ApiProperty({ nullable: true, example: 'RT-07' })
  robotaxiId!: string | null;
}

export class OperatorAlertsResponseDto implements OperatorAlertsResponse {
  @ApiProperty({ type: [OperatorAlertDto], description: 'Dal più recente.' })
  alerts!: OperatorAlertDto[];
}
