import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { API_ROUTES } from '@road/shared';

import { ClockPort } from '../platform/clock.port';
import { HealthResponseDto } from './dto/health-response.dto';

/**
 * L'unico endpoint di M0: dice se il servizio è in piedi.
 *
 * Sta nel modulo `gateway` perché è lì che vive tutto ciò che è esposto su HTTP (DD §2.2), e
 * inietta `ClockPort` — non `new Date()` — perché la Regola 3 non ha eccezioni fuori da `platform`.
 */
@ApiTags('system')
@Controller()
export class HealthController {
  constructor(
    private readonly clock: ClockPort,
    private readonly config: ConfigService,
  ) {}

  @Get(API_ROUTES.health)
  @ApiOperation({
    summary: 'Stato del servizio',
    description: "Ritorna 200 quando l'API è in grado di servire richieste.",
  })
  @ApiOkResponse({ type: HealthResponseDto })
  getHealth(): HealthResponseDto {
    return {
      status: 'ok',
      service: 'road-api',
      version: this.config.get<string>('API_VERSION', '0.1.0'),
      time: this.clock.now().toISOString(),
    };
  }
}
