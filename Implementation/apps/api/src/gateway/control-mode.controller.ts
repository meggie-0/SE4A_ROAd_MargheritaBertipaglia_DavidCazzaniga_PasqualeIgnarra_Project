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
import { API_ROUTES, enableAutoModeRequestSchema, type EnableAutoModeRequest } from '@road/shared';

import { AllocationPort } from '../allocation/allocation.port';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/access-control.port';
import { ModePort } from '../mode/mode.port';

import { EnableAutoModeRequestDto, ModeResponseDto } from './dto/mode.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Lettura del modo di controllo e rientro in modo Auto (RASD R12, R13; NFR9, NFR10).
 *
 * Due sole rotte, entrambe riservate all'operatore con i guard di M1b. La `GET` esiste perché NFR10
 * chiede che il modo sia sempre visibile sulla dashboard (DD §3.2) e NFR6 che lo sia insieme alla
 * strategia attiva al primo caricamento: per questo la risposta porta i due valori insieme, letti
 * dalle rispettive porte.
 *
 * **Non c'è una rotta per entrare in modo Manual**, e non è una dimenticanza: R13 lega il modo
 * Manual alla scelta di una politica — «if the Operator manually selects a specific allocation
 * strategy […] the system immediately transitions to Manual Mode» — quindi ci si entra da
 * `PUT /allocation/strategy`. Una rotta che portasse in Manual senza dire quale strategia usare
 * dovrebbe inventarne una, e nessun documento gliene dà il diritto.
 */
/**
 * Il nome è `ControlModeController` e non `ModeController` di proposito: quel nome, nel DD §2.2,
 * appartiene al **componente di dominio** che vive in `src/mode/`. Due classi omonime in due moduli
 * diversi si distinguerebbero solo dal percorso dell'import, e la prima volta che qualcuno importa
 * quella sbagliata il messaggio d'errore parlerebbe d'altro.
 */
@ApiTags('mode')
@Controller()
export class ControlModeController {
  constructor(
    private readonly mode: ModePort,
    /**
     * La strategia attiva la sa dire `allocation`, non `mode`: il DD §2.2.1 assegna
     * `getActiveStrategy()` all'`AllocationManager`, e comporre due letture in una risposta è
     * esattamente ciò che un gateway fa. Ciò che non fa è decidere: nessuna delle due porte viene
     * usata per altro che leggere e delegare.
     */
    private readonly allocation: AllocationPort,
  ) {}

  @Get(API_ROUTES.mode)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Legge il modo di controllo e la strategia attiva',
    description:
      'NFR10: il modo corrente è sempre visibile sulla dashboard. I due valori vengono dal ' +
      'record `system_mode`, la loro unica sede autorevole, quindi due repliche del tier ' +
      'applicativo rispondono la stessa cosa (NFR3).',
  })
  @ApiOkResponse({ type: ModeResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async getMode(): Promise<ModeResponseDto> {
    return this.currentMode();
  }

  @Put(API_ROUTES.mode)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Riabilita il modo Auto',
    description:
      "R13: il sistema resta in Manual finché l'operatore non riabilita Auto esplicitamente. " +
      "Il rientro **rivaluta subito** l'ultimo livello di traffico noto e applica la strategia " +
      'che gli compete, quindi la strategia nella risposta può essere diversa da quella scelta a ' +
      'mano. Se il livello è Medium resta quella attiva in quell istante.',
  })
  @ApiBody({ type: EnableAutoModeRequestDto })
  @ApiOkResponse({ type: ModeResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async enableAuto(
    @Body(new ZodValidationPipe(enableAutoModeRequestSchema)) _body: EnableAutoModeRequest,
  ): Promise<ModeResponseDto> {
    await this.mode.enableAuto();

    // Si rilegge invece di riecheggiare la richiesta, come fa la `PUT` della strategia: la
    // risposta descrive lo stato del sistema **dopo** la rivalutazione, che è precisamente ciò che
    // il chiamante non poteva prevedere.
    return this.currentMode();
  }

  /** Modo e strategia insieme: la coppia che il pannello di controllo mostra (DD §3.2). */
  private async currentMode(): Promise<ModeResponseDto> {
    const [mode, activeStrategy] = await Promise.all([
      this.mode.getMode(),
      this.allocation.getActiveStrategy(),
    ]);
    return { mode, activeStrategy };
  }
}
