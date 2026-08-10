import { ApiProperty } from '@nestjs/swagger';
import type { HealthResponse } from '@road/shared';

/**
 * Il DTO che finisce in `contracts/openapi.json`.
 *
 * `implements HealthResponse` non è decorativo: lo schema Zod di `packages/shared` è la sorgente
 * unica di verità (DD §2.2.1) e il compilatore fallisce se questo DTO se ne discosta. È il modo
 * più economico per tenere allineati contratto pubblicato e tipi condivisi senza aggiungere
 * librerie fuori dall'elenco ammesso in MILESTONES.md.
 */
export class HealthResponseDto implements HealthResponse {
  @ApiProperty({ enum: ['ok'], example: 'ok', description: 'Stato del servizio.' })
  status!: 'ok';

  @ApiProperty({ example: 'road-api', description: 'Nome del servizio che risponde.' })
  service!: string;

  @ApiProperty({ example: '0.1.0', description: "Versione dell'API in esecuzione." })
  version!: string;

  @ApiProperty({
    example: '2026-01-01T08:00:00.000Z',
    description: 'Istante della risposta in ISO 8601, letto da ClockPort.',
  })
  time!: string;
}
