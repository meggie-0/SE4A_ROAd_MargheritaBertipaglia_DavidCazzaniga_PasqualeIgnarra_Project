import { ApiProperty } from '@nestjs/swagger';
import {
  ROBOTAXI_STATES,
  type FleetStatusResponse,
  type FleetVehicle,
  type GeoPoint,
  type RobotaxiState,
} from '@road/shared';

import { GeoPointDto } from './rides.dto';

/**
 * I DTO della panoramica di flotta (M8, RASD R7 e G8; DD §3.2).
 *
 * `implements` i tipi di `packages/shared` come ogni altro DTO del gateway: se lo schema Zod e
 * questa classe divergessero, il compilatore lo direbbe prima che il contratto pubblicato mentisse
 * alla dashboard.
 */

export class FleetVehicleDto implements FleetVehicle {
  @ApiProperty({ example: 'rt-07', description: "L'identificatore del veicolo." })
  id!: string;

  @ApiProperty({
    enum: ROBOTAXI_STATES,
    example: 'ARRIVING',
    description:
      'Lo stato corrente secondo la macchina a sette stati del DD §2.6.3, Figura 2.10. È ciò ' +
      'che decide il colore del marker sulla mappa.',
  })
  state!: RobotaxiState;

  @ApiProperty({ type: GeoPointDto, description: "L'ultima posizione osservata del veicolo." })
  position!: GeoPoint;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'duomo',
    description: 'La zona di Milano in cui il veicolo si trova.',
  })
  zoneId!: string | null;

  @ApiProperty({
    example: '2026-05-04T09:30:10.000Z',
    description: "Quando la riga del veicolo è stata scritta l'ultima volta.",
  })
  updatedAt!: string;
}

export class FleetStatusResponseDto implements FleetStatusResponse {
  @ApiProperty({
    example: '2026-05-04T09:30:12.000Z',
    description: "L'istante a cui la fotografia si riferisce, letto da ClockPort.",
  })
  observedAt!: string;

  @ApiProperty({ example: 20, description: 'Quanti veicoli compongono la flotta.' })
  total!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'integer' },
    example: {
      AVAILABLE: 14,
      ASSIGNED: 2,
      ARRIVING: 1,
      ARRIVED: 0,
      IN_RIDE: 2,
      REBALANCING: 1,
      MAINTENANCE: 0,
    },
    description:
      'Un contatore per ognuno dei sette stati, zeri compresi: è il riepilogo che la status bar ' +
      'della dashboard mostra (DD §3.2).',
  })
  countsByState!: Record<RobotaxiState, number>;

  @ApiProperty({
    type: [FleetVehicleDto],
    description:
      "I veicoli della flotta, in ordine di identificatore crescente com'esce dalla porta.",
  })
  robotaxis!: FleetVehicleDto[];
}
