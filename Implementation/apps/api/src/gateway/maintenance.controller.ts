import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  API_ROUTES,
  startMaintenanceRequestSchema,
  type StartMaintenanceRequest,
} from '@road/shared';

import { JwtAuthGuard, Roles, RolesGuard } from '../auth/access-control.port';
import { UnknownRobotaxiError } from '../fleet/fleet-monitor.port';
import {
  ConcurrentTransitionError,
  IllegalTransitionError,
  type RobotaxiSnapshot,
} from '../fleet/robotaxi.port';
import { MaintenancePort } from '../maintenance/maintenance.port';
import type { MaintenanceRecord } from '../persistence/persistence.port';

import {
  MaintenanceCompletedResponseDto,
  MaintenanceRecordDto,
  MaintenanceStartedResponseDto,
  StartMaintenanceRequestDto,
} from './dto/maintenance.dto';
import { FleetVehicleDto } from './dto/fleet.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

@ApiTags('maintenance')
@Controller()
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenancePort) {}

  /**
   * Mette un robotaxi AVAILABLE in manutenzione.
   */
  @Post(API_ROUTES.maintenanceStart)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Mette un robotaxi in manutenzione',
    description:
      'R9: il robotaxi passa da AVAILABLE a MAINTENANCE, viene escluso dalle assegnazioni e viene aperto un record di manutenzione.',
  })
  @ApiParam({
    name: 'robotaxiId',
    example: 'rt-07',
    description: 'Identificatore del robotaxi.',
  })
  @ApiBody({ type: StartMaintenanceRequestDto })
  @ApiCreatedResponse({ type: MaintenanceStartedResponseDto })
  @ApiBadRequestResponse({
    description: 'Il motivo è assente, vuoto oppure supera 255 caratteri.',
  })
  @ApiUnauthorizedResponse({
    description: 'Token assente, scaduto o non valido.',
  })
  @ApiForbiddenResponse({
    description: 'Serve un account operatore.',
  })
  @ApiNotFoundResponse({
    description: 'Il robotaxi indicato non esiste.',
  })
  @ApiConflictResponse({
    description: 'Il robotaxi non è AVAILABLE oppure il suo stato è cambiato durante la richiesta.',
  })
  async startMaintenance(
    @Param('robotaxiId') robotaxiId: string,
    @Body(new ZodValidationPipe(startMaintenanceRequestSchema))
    body: StartMaintenanceRequest,
  ): Promise<MaintenanceStartedResponseDto> {
    try {
      const result = await this.maintenance.requestMaintenance(robotaxiId, body.reason);

      return {
        robotaxi: fleetVehicleDtoOf(result.robotaxi),
        record: maintenanceRecordDtoOf(result.record),
      };
    } catch (error) {
      this.translateError(error);
    }
  }

  /**
   * Completa la manutenzione e rimette il robotaxi in servizio.
   */
  @Post(API_ROUTES.maintenanceComplete)
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Completa la manutenzione di un robotaxi',
    description:
      'R9: il robotaxi passa da MAINTENANCE ad AVAILABLE e il record dell’intervento viene chiuso.',
  })
  @ApiParam({
    name: 'robotaxiId',
    example: 'rt-07',
    description: 'Identificatore del robotaxi.',
  })
  @ApiOkResponse({ type: MaintenanceCompletedResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Token assente, scaduto o non valido.',
  })
  @ApiForbiddenResponse({
    description: 'Serve un account operatore.',
  })
  @ApiNotFoundResponse({
    description: 'Il robotaxi indicato non esiste.',
  })
  @ApiConflictResponse({
    description:
      'Il robotaxi non è in MAINTENANCE oppure il suo stato è cambiato durante la richiesta.',
  })
  async completeMaintenance(
    @Param('robotaxiId') robotaxiId: string,
  ): Promise<MaintenanceCompletedResponseDto> {
    try {
      const result = await this.maintenance.completeMaintenance(robotaxiId);

      return {
        robotaxi: fleetVehicleDtoOf(result.robotaxi),
        record: result.record === null ? null : maintenanceRecordDtoOf(result.record),
      };
    } catch (error) {
      this.translateError(error);
    }
  }

  /**
   * Traduce gli errori del dominio nei rispettivi errori HTTP.
   */
  private translateError(error: unknown): never {
    if (error instanceof UnknownRobotaxiError) {
      throw new NotFoundException(error.message);
    }

    if (error instanceof IllegalTransitionError || error instanceof ConcurrentTransitionError) {
      throw new ConflictException(error.message);
    }

    throw error;
  }
}

/**
 * Converte il robotaxi interno nella forma pubblica condivisa.
 */
function fleetVehicleDtoOf(robotaxi: RobotaxiSnapshot): FleetVehicleDto {
  return {
    id: robotaxi.id,
    state: robotaxi.state,
    position: {
      lat: robotaxi.lat,
      lon: robotaxi.lon,
    },
    zoneId: robotaxi.zoneId,
    updatedAt: robotaxi.updatedAt.toISOString(),
  };
}

/**
 * Converte le Date interne in stringhe ISO utilizzabili nel JSON.
 */
function maintenanceRecordDtoOf(record: MaintenanceRecord): MaintenanceRecordDto {
  return {
    id: record.id,
    robotaxiId: record.robotaxiId,
    reason: record.reason,
    status: record.status,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt?.toISOString() ?? null,
  };
}
