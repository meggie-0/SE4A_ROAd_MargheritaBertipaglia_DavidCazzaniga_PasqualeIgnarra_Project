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
import { FleetMonitorPort } from '../fleet/fleet-monitor.port';

import { FleetStatusResponseDto } from './dto/fleet.dto';

/**
 * La panoramica di flotta per la dashboard operatore (RASD R7, G8; DD §3.2).
 *
 * Una sola rotta, in sola lettura, riservata all'operatore con i guard di M1b.
 *
 * **Perché nasce solo adesso.** `FleetMonitorPort.getFleetStatus()` esiste dal M2 e la sua forma
 * non cambia qui: fino a M7 però nessun client la guardava, e una rotta senza lettori sarebbe stata
 * una funzionalità non richiesta. Con la dashboard di M8 R7 diventa osservabile — «a live overview
 * of the fleet», che nessuno può vedere, non è una panoramica — e questo è l'arco
 * `APIGateway → FleetMonitor` che il DD disegna nella vista di deployment.
 *
 * **Non c'è una rotta per muovere un veicolo, e non ci sarà.** Le transizioni le innescano la
 * telemetria (M7), il ciclo di riposizionamento (M6) e la catena della corsa (M4): un endpoint che
 * le comandasse a mano darebbe all'operatore un potere che nessun requisito gli attribuisce, e
 * aggirerebbe le guardie della Figura 2.10 che dipendono dalla posizione reale del veicolo.
 */
@ApiTags('fleet')
@Controller()
export class FleetController {
  constructor(private readonly fleet: FleetMonitorPort) {}

  @Get(API_ROUTES.fleetStatus)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Legge posizione e stato di ogni veicolo della flotta',
    description:
      'R7: la vista in tempo reale che la dashboard disegna sulla mappa, più il riepilogo per ' +
      'stato della status bar (DD §3.2). Le posizioni non viaggiano sul canale push — cambiano a ' +
      'ogni tick e lo inonderebbero — quindi la dashboard le rilegge da qui; le transizioni di ' +
      'stato continuano ad arrivare push, come ogni altro evento di flotta.',
  })
  @ApiOkResponse({ type: FleetStatusResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async getFleetStatus(): Promise<FleetStatusResponseDto> {
    const status = await this.fleet.getFleetStatus();

    // Le uniche trasformazioni sono le date, che diventano stringhe ISO 8601, e la posizione, che
    // si annida in `position`: il dominio lavora con `Date` e con una riga piatta, JSON e la mappa
    // no. È la stessa divisione di responsabilità del canale push e degli altri controller — e i
    // campi si elencano uno per uno, così una colonna in più sulla riga del veicolo non se ne esce
    // dall'API senza che nessuno protesti.
    return {
      observedAt: status.observedAt.toISOString(),
      total: status.total,
      countsByState: { ...status.countsByState },
      robotaxis: status.robotaxis.map((vehicle) => ({
        id: vehicle.id,
        state: vehicle.state,
        position: { lat: vehicle.lat, lon: vehicle.lon },
        zoneId: vehicle.zoneId,
        updatedAt: vehicle.updatedAt.toISOString(),
      })),
    };
  }
}
