import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  API_ROUTES,
  setActiveStrategyRequestSchema,
  type SetActiveStrategyRequest,
} from '@road/shared';

import { AllocationPort } from '../allocation/allocation.port';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/access-control.port';
import { ModePort } from '../mode/mode.port';

import { ActiveStrategyResponseDto, SetActiveStrategyRequestDto } from './dto/allocation.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Lettura e cambio della strategia di allocazione (RASD R8, G5).
 *
 * È il primo endpoint riservato all'operatore, e usa il meccanismo consegnato da M1b senza
 * aggiungerci nulla: `JwtAuthGuard` stabilisce chi sei, `RolesGuard` con `@Roles('OPERATOR')` che
 * puoi. Un token `PASSENGER` riceve 403 su entrambe le rotte.
 *
 * R8 chiede il cambio «a runtime, senza interruzione del servizio»: la `PUT` scrive un record e
 * l'allocazione successiva legge il nuovo valore: nessun riavvio, nessuna riconfigurazione, e —
 * poiché la sede autorevole è il database e non la memoria di un processo — anche le altre repliche
 * del tier applicativo allocano subito con la nuova politica (NFR3).
 *
 * **[M6] La `PUT` passa da `ModePort.setManual()`**, come la Figura 2.6 prescrive. In M3 chiamava
 * direttamente `AllocationPort.setActiveStrategy(name, 'manual')`, che produceva lo stesso effetto
 * sul database perché quella scrittura porta con sé il passaggio in modo Manual; ciò che mancava
 * era l'annuncio all'operatore — l'`ManualOverrideEvent` della figura — che `ModeController` emette
 * e che le altre dashboard connesse hanno bisogno di ricevere. La `GET` resta su `AllocationPort`:
 * la strategia attiva è roba sua (DD §2.2.1), e chiedere il modo per leggerla sarebbe passare da
 * un componente che non la possiede.
 */
@ApiTags('allocation')
@Controller()
export class AllocationController {
  constructor(
    private readonly allocation: AllocationPort,
    private readonly mode: ModePort,
  ) {}

  @Get(API_ROUTES.allocationStrategy)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Legge la strategia di allocazione attiva',
    description:
      'R8: la dashboard operatore mostra sempre quale politica sta assegnando i veicoli ' +
      "(DD §3.2). Il valore viene dal record `system_mode`, l'unica sede autorevole.",
  })
  @ApiOkResponse({ type: ActiveStrategyResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async getActiveStrategy(): Promise<ActiveStrategyResponseDto> {
    return { activeStrategy: await this.allocation.getActiveStrategy() };
  }

  @Put(API_ROUTES.allocationStrategy)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Cambia la strategia di allocazione',
    description:
      'R8: il cambio ha effetto sulla prima allocazione successiva, senza interruzione del ' +
      'servizio. Essendo una scelta umana porta il sistema in modo Manual nella stessa ' +
      'transazione, e da quel momento nessun cambio automatico avviene finché un operatore non ' +
      'riabilita il modo Auto (NFR10, M6).',
  })
  @ApiBody({ type: SetActiveStrategyRequestDto })
  @ApiOkResponse({ type: ActiveStrategyResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async setActiveStrategy(
    @Body(new ZodValidationPipe(setActiveStrategyRequestSchema)) body: SetActiveStrategyRequest,
  ): Promise<ActiveStrategyResponseDto> {
    await this.mode.setManual(body.strategy);

    // Si rilegge invece di riecheggiare il corpo della richiesta: la risposta descrive lo stato
    // del sistema, e se un altro scrittore fosse arrivato nel frattempo l'eco direbbe una cosa
    // falsa. Non c'è `UnknownStrategyError` da tradurre: lo schema condiviso ammette solo i nomi
    // registrati, e un corpo diverso non arriva fin qui.
    return { activeStrategy: await this.allocation.getActiveStrategy() };
  }
}
