import { ApiProperty } from '@nestjs/swagger';
import {
  MAINTENANCE_STATUSES,
  type MaintenanceCompletedResponse,
  type MaintenanceRecordResponse,
  type MaintenanceStartedResponse,
  type MaintenanceStatus,
  type StartMaintenanceRequest,
} from '@road/shared';

import { FleetVehicleDto } from './fleet.dto';

/**
 * Body utilizzato per mettere un robotaxi in manutenzione.
 */
export class StartMaintenanceRequestDto implements StartMaintenanceRequest {
  @ApiProperty({
    example: 'Controllo periodico dei sensori',
    minLength: 1,
    maxLength: 255,
    description: 'Il motivo per cui il veicolo viene messo fuori servizio.',
  })
  reason!: string;
}

/**
 * Periodo di manutenzione registrato nel database.
 */
export class MaintenanceRecordDto implements MaintenanceRecordResponse {
  @ApiProperty({
    format: 'uuid',
    description: "Identificatore dell'intervento di manutenzione.",
  })
  id!: string;

  @ApiProperty({
    example: 'rt-07',
    description: 'Robotaxi interessato dalla manutenzione.',
  })
  robotaxiId!: string;

  @ApiProperty({
    example: 'Controllo periodico dei sensori',
    description: "Motivo dell'intervento.",
  })
  reason!: string;

  @ApiProperty({
    enum: MAINTENANCE_STATUSES,
    example: 'ONGOING',
    description: "Stato dell'intervento di manutenzione.",
  })
  status!: MaintenanceStatus;

  @ApiProperty({
    format: 'date-time',
    example: '2026-08-17T09:30:00.000Z',
    description: "Istante di inizio dell'intervento.",
  })
  startedAt!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    example: null,
    description: "Istante di completamento dell'intervento, oppure null se è ancora in corso.",
  })
  endedAt!: string | null;
}

/**
 * Risposta quando la manutenzione viene avviata.
 */
export class MaintenanceStartedResponseDto implements MaintenanceStartedResponse {
  @ApiProperty({
    type: FleetVehicleDto,
    description: 'Robotaxi dopo il passaggio allo stato MAINTENANCE.',
  })
  robotaxi!: FleetVehicleDto;

  @ApiProperty({
    type: MaintenanceRecordDto,
    description: 'Intervento di manutenzione appena aperto.',
  })
  record!: MaintenanceRecordDto;
}

/**
 * Risposta quando la manutenzione viene completata.
 */
export class MaintenanceCompletedResponseDto implements MaintenanceCompletedResponse {
  @ApiProperty({
    type: FleetVehicleDto,
    description: 'Robotaxi dopo il ritorno allo stato AVAILABLE.',
  })
  robotaxi!: FleetVehicleDto;

  @ApiProperty({
    type: MaintenanceRecordDto,
    nullable: true,
    description:
      'Intervento appena concluso. Può essere null per un veicolo inizializzato dal seed.',
  })
  record!: MaintenanceRecordDto | null;
}
