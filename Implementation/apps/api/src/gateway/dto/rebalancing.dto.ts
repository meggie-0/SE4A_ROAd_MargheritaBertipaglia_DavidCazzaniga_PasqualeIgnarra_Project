import { ApiProperty } from '@nestjs/swagger';
import type { DemandAnalysisResponse, ZoneDemand } from '@road/shared';

/**
 * I DTO dell'analisi della domanda (M6, RASD R10 e G9).
 *
 * `implements` i tipi di `packages/shared` come tutti gli altri: se lo schema Zod e questa classe
 * divergessero, il compilatore lo direbbe prima che il contratto pubblicato mentisse ai client.
 */

export class ZoneDemandDto implements ZoneDemand {
  @ApiProperty({ example: 'san-siro', description: "L'identificatore della zona." })
  zoneId!: string;

  @ApiProperty({ example: 'San Siro', description: 'Il nome leggibile della zona.' })
  zoneName!: string;

  @ApiProperty({
    example: 3,
    description:
      'La domanda storica della zona nella fascia oraria settimanale corrente, in ora locale ' +
      'di Milano.',
  })
  baseDemand!: number;

  @ApiProperty({
    example: 24,
    description:
      'La domanda attesa: la base per il prodotto dei moltiplicatori degli eventi attivi.',
  })
  expectedDemand!: number;

  @ApiProperty({
    example: 2,
    description: 'I veicoli inattivi che si trovano nella zona in questo momento.',
  })
  availableRobotaxis!: number;

  @ApiProperty({
    example: 22,
    description:
      'Domanda attesa meno veicoli inattivi. È la quantità su cui il riposizionamento ordina ' +
      'le zone: positivo significa zona scoperta.',
  })
  deficit!: number;

  @ApiProperty({
    type: [String],
    example: ['Partita di campionato'],
    description: 'Gli eventi attivi nella zona in questo istante, in ordine alfabetico.',
  })
  activeEvents!: string[];
}

export class DemandAnalysisResponseDto implements DemandAnalysisResponse {
  @ApiProperty({
    example: '2026-05-04T19:30:00.000Z',
    description: "L'istante a cui la stima si riferisce.",
  })
  analyzedAt!: string;

  @ApiProperty({
    type: [ZoneDemandDto],
    description:
      'Le zone per domanda attesa decrescente, pareggi sull identificatore crescente. ' +
      "L'ordine fa parte del contratto.",
  })
  zones!: ZoneDemandDto[];
}
