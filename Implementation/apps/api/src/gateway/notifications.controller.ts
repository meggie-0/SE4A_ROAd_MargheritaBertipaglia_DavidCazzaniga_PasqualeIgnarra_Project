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
import { OperatorAlertPort } from '../notifications/operator-alert.port';

import { OperatorAlertsResponseDto } from './dto/notifications.dto';

/**
 * Lo storico degli alert dell'operatore (decisione D77; RASD R7, R11, R12, R13; G8, G9).
 *
 * È la **controparte in lettura del canale push**, e nasce da un difetto: il canale consegna a chi è
 * connesso, e per gli alert dell'operatore non esisteva nient'altro. Chi ricaricava la pagina, chi
 * arrivava dopo, o chi voleva semplicemente rivedere cosa fosse successo, trovava un pannello vuoto
 * — una dashboard che, dopo sei riposizionamenti, dichiara di non aver fatto niente.
 *
 * **Sola lettura, e senza parametri.** Il numero di righe lo decide il server: è un pannello che
 * mostra gli ultimi eventi, non un archivio da sfogliare. Un parametro di paginazione che nessun
 * client passa è superficie di contratto che nessuno prova.
 */

/**
 * Quanti alert restituire.
 *
 * Coincide con `MAX_NOTIFICATIONS` del client, e la coincidenza è voluta: il pannello fonde storico
 * e canale push nella stessa lista, e due limiti diversi produrrebbero una lista che si accorcia o
 * si allunga a seconda di quale delle due sorgenti ha portato l'ultimo evento.
 */
const RECENT_ALERTS_LIMIT = 50;

@ApiTags('notifications')
@Controller()
export class NotificationsController {
  constructor(private readonly alerts: OperatorAlertPort) {}

  @Get(API_ROUTES.operatorAlerts)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Gli ultimi alert sul governo del sistema, dal più recente',
    description:
      'Switch automatici di strategia, rientri in modo Auto, soglie di traffico raggiunte e ' +
      'riposizionamenti avviati. Non sono le notifiche del RASD §2.2.3, che sono indirizzate a un ' +
      'passeggero: questi non hanno destinatario e li vede chiunque apra la dashboard, anche chi ' +
      'si è collegato dopo che sono accaduti (decisione D77).',
  })
  @ApiOkResponse({ type: OperatorAlertsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async getOperatorAlerts(): Promise<OperatorAlertsResponseDto> {
    const alerts = await this.alerts.recentAlerts(RECENT_ALERTS_LIMIT);

    // L'unica trasformazione è la data, che diventa una stringa ISO 8601: il dominio lavora con
    // `Date`, JSON no. È la stessa divisione del canale push e di `GET /rebalancing/demand`.
    return {
      alerts: alerts.map((alert) => ({ ...alert, occurredAt: alert.occurredAt.toISOString() })),
    };
  }
}
