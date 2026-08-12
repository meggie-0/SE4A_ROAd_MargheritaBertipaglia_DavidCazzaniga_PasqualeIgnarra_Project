import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { API_ROUTES } from '@road/shared';

import { JwtAuthGuard, Roles, RolesGuard } from '../auth/access-control.port';
import { RebalancingPort } from '../rebalancing/rebalancing.port';

import { DemandAnalysisResponseDto } from './dto/rebalancing.dto';

/**
 * L'analisi della domanda per la dashboard operatore (RASD R10, G9).
 *
 * Una sola rotta, in sola lettura. R10 chiede che il sistema «identifichi le zone ad alta domanda»,
 * e un'identificazione che nessuno può guardare non è osservabile: questo endpoint è ciò che la
 * rende tale, ed è l'arco `APIGateway → RebalancingManager` che il DD disegna nella vista di
 * deployment.
 *
 * **Non c'è una rotta per innescare un riposizionamento.** Il ciclo lo guida
 * `RebalancingScheduler` (DD §2.4, Figura 2.7) e i suoi effetti si osservano sul canale push, come
 * ogni altro movimento di flotta. Il ramo con approvazione dell'operatore esiste nella Figura 3.3
 * del RASD ma il DD non l'ha adottato, e aggiungerlo qui significherebbe implementare un flusso che
 * nessuno dei due documenti autorevoli descrive.
 */
@ApiTags('rebalancing')
@Controller()
export class RebalancingController {
  constructor(private readonly rebalancing: RebalancingPort) {}

  @Get(API_ROUTES.rebalancingDemand)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Stima la domanda attesa per zona',
    description:
      'R10: combina la base storica della fascia oraria corrente — in ora locale di Milano — con ' +
      'i moltiplicatori degli eventi attivi in questo istante. Le zone escono per domanda attesa ' +
      'decrescente, pareggi sull identificatore crescente. Non muove nessun veicolo: è una stima.',
  })
  @ApiOkResponse({ type: DemandAnalysisResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async getDemand(): Promise<DemandAnalysisResponseDto> {
    const analysis = await this.rebalancing.analyzeDemand();

    // L'istante lo mette il dominio, non il gateway: `analyzeDemand()` lo prende da `ClockPort`, e
    // qui non c'è un orologio da cui prenderlo (CLAUDE.md Regola 3). L'unica trasformazione è la
    // data, che diventa una stringa ISO 8601 — la stessa divisione di responsabilità del canale
    // push: il dominio lavora con `Date`, JSON no.
    return {
      analyzedAt: analysis.analyzedAt.toISOString(),
      zones: analysis.zones.map((zone) => ({ ...zone, activeEvents: [...zone.activeEvents] })),
    };
  }
}
