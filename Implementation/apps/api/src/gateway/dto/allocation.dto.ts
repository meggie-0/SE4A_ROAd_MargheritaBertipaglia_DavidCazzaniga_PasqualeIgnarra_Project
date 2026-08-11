import { ApiProperty } from '@nestjs/swagger';
import {
  STRATEGY_NAMES,
  type ActiveStrategyResponse,
  type SetActiveStrategyRequest,
  type StrategyName,
} from '@road/shared';

/**
 * I DTO della strategia di allocazione (M3, RASD R8 e G5).
 *
 * Come quelli di M1b, ognuno `implements` il tipo corrispondente di `packages/shared`: gli schemi
 * Zod sono la sorgente unica di verità e il compilatore fallisce se contratto pubblicato e tipi
 * condivisi divergono. L'insieme dei valori ammessi è `STRATEGY_NAMES`, quindi il client legge
 * dall'OpenAPI le stesse due politiche che il database accetta in colonna.
 */

export class ActiveStrategyResponseDto implements ActiveStrategyResponse {
  @ApiProperty({
    enum: STRATEGY_NAMES,
    example: 'NEAREST_AVAILABLE',
    description: 'La politica con cui il sistema sta assegnando i veicoli in questo momento.',
  })
  activeStrategy!: StrategyName;
}

export class SetActiveStrategyRequestDto implements SetActiveStrategyRequest {
  @ApiProperty({
    enum: STRATEGY_NAMES,
    example: 'MINIMUM_ETA',
    description:
      'La politica da rendere attiva. La scelta di un operatore è per definizione un intervento ' +
      'manuale: porta il sistema in modo Manual e sospende i cambi automatici (NFR10).',
  })
  strategy!: StrategyName;
}
