import { ApiProperty } from '@nestjs/swagger';
import {
  CONTROL_MODES,
  STRATEGY_NAMES,
  TRAFFIC_LEVELS,
  type ControlMode,
  type EnableAutoModeRequest,
  type ModeResponse,
  type StrategyName,
  type TrafficLevel,
} from '@road/shared';

/**
 * I DTO del modo di controllo (M6, RASD R12 e R13; NFR9, NFR10).
 *
 * Come tutti gli altri, ognuno `implements` il tipo corrispondente di `packages/shared`: gli schemi
 * Zod sono la sorgente unica di verità e il compilatore fallisce se il contratto pubblicato e i
 * tipi condivisi divergono.
 */

export class ModeResponseDto implements ModeResponse {
  @ApiProperty({
    enum: CONTROL_MODES,
    example: 'AUTO',
    description:
      'Il modo di controllo corrente. In Auto il sistema commuta la strategia in base al ' +
      'traffico; in Manual segue la scelta dell operatore e sospende ogni cambio automatico.',
  })
  mode!: ControlMode;

  @ApiProperty({
    enum: STRATEGY_NAMES,
    example: 'NEAREST_AVAILABLE',
    description:
      'La politica attiva dopo l operazione. Compare anche qui perché il pannello di controllo ' +
      'della dashboard mostra i due valori insieme, e perché il rientro in modo Auto può ' +
      'cambiarla subito rivalutando l ultimo livello di traffico noto.',
  })
  activeStrategy!: StrategyName;

  @ApiProperty({
    enum: TRAFFIC_LEVELS,
    nullable: true,
    example: 'LOW',
    description:
      'L ultimo livello di traffico osservato, `null` se nessuna lettura è ancora arrivata. Il ' +
      'RASD §2.3 lo mette fra i bisogni dell operatore accanto al modo operativo. Su Medium il ' +
      'sistema **avvisa e non commuta**: è la banda morta che NFR9 richiede, e la scelta resta ' +
      'all operatore. In modo Manual le letture continuano a registrarsi senza commutare nulla ' +
      '(R13), quindi questo campo può non corrispondere alla strategia attiva.',
  })
  trafficLevel!: TrafficLevel | null;
}

export class EnableAutoModeRequestDto implements EnableAutoModeRequest {
  @ApiProperty({
    enum: ['AUTO'],
    example: 'AUTO',
    description:
      'L unico valore ammesso. In modo Manual non ci si porta dichiarandolo: ci si finisce ' +
      'scegliendo una strategia su PUT /allocation/strategy, come prescrive R13.',
  })
  mode!: 'AUTO';
}
