import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  RIDE_REQUEST_KINDS,
  RIDE_REQUEST_STATUSES,
  type GeoPointPayload,
  type RideRequestKind,
  type RideRequestResponse,
  type RideRequestStatus,
  type SubmitAdvanceBookingRequest,
  type SubmitImmediateRideRequest,
} from '@road/shared';

/**
 * I DTO delle richieste di corsa (M4, RASD R3, R4 e R14).
 *
 * Come quelli di M1b e M3, ognuno `implements` il tipo corrispondente di `packages/shared`: gli
 * schemi Zod sono la sorgente unica di verità, e il compilatore fallisce se contratto pubblicato e
 * tipi condivisi divergono.
 */

export class GeoPointDto implements GeoPointPayload {
  @ApiProperty({ example: 45.4642, minimum: -90, maximum: 90, description: 'Latitudine.' })
  lat!: number;

  @ApiProperty({ example: 9.19, minimum: -180, maximum: 180, description: 'Longitudine.' })
  lon!: number;
}

export class SubmitImmediateRideRequestDto implements SubmitImmediateRideRequest {
  @ApiProperty({ type: GeoPointDto, description: 'Dove il passeggero vuole essere prelevato.' })
  pickup!: GeoPointPayload;

  @ApiPropertyOptional({ example: 'Piazza del Duomo, Milano' })
  pickupAddress?: string;

  @ApiProperty({ type: GeoPointDto, description: 'Dove la corsa deve terminare.' })
  destination!: GeoPointPayload;

  @ApiPropertyOptional({ example: 'Stazione Centrale, Milano' })
  destinationAddress?: string;
}

export class SubmitAdvanceBookingRequestDto
  extends SubmitImmediateRideRequestDto
  implements SubmitAdvanceBookingRequest
{
  @ApiProperty({
    example: '2026-05-04T18:30:00.000Z',
    format: 'date-time',
    description:
      "L'orario concordato del prelievo, con fuso orario. Dev'essere successivo ad adesso: il " +
      "sistema riserva il veicolo a partire da quell'orario meno l'anticipo di attivazione.",
  })
  scheduledPickup!: string;
}

/**
 * La richiesta come la vedono i client, in risposta a tutte e tre le operazioni.
 *
 * Una richiesta che nessun veicolo può servire torna qui con `status: REJECTED` e codice 201: il
 * rifiuto è un esito previsto del dominio (RASD Figura 3.1), non un guasto della chiamata, e un
 * 4xx lo confonderebbe con una richiesta malformata.
 */
export class RideRequestResponseDto implements RideRequestResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RIDE_REQUEST_KINDS, example: 'IMMEDIATE' })
  kind!: RideRequestKind;

  @ApiProperty({
    enum: RIDE_REQUEST_STATUSES,
    example: 'ACCEPTED',
    description:
      'Lo stato della richiesta. `REJECTED` significa che nessun veicolo era idoneo; `ACCEPTED` ' +
      'che uno è stato riservato — e, per una corsa immediata, anche assegnato.',
  })
  status!: RideRequestStatus;

  @ApiProperty({ type: GeoPointDto })
  pickup!: GeoPointPayload;

  @ApiProperty({ type: String, nullable: true, example: 'Piazza del Duomo, Milano' })
  pickupAddress!: string | null;

  @ApiProperty({ type: GeoPointDto })
  destination!: GeoPointPayload;

  @ApiProperty({ type: String, nullable: true, example: 'Stazione Centrale, Milano' })
  destinationAddress!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'RT-07',
    description:
      'Il veicolo **assegnato**. Per una prenotazione anticipata accettata resta `null` fino ' +
      "all'attivazione: fino a quel momento il veicolo è riservato, e se nel frattempo finisce in " +
      'manutenzione ne arriva un altro.',
  })
  assignedRobotaxiId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description: 'Presente solo per le prenotazioni anticipate.',
  })
  scheduledPickup!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}
