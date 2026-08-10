import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { ClockPort } from './clock.port';
import { RandomPort } from './random.port';
import { SeededRandom } from './seeded-random';
import { SystemClock } from './system-clock';

/**
 * Il modulo `platform` (CLAUDE.md Regola 1) è l'unico posto in cui il backend tocca l'orologio di
 * sistema e la casualità. Espone due porte, non una: `ClockPort` e `RandomPort`.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    { provide: ClockPort, useClass: SystemClock },
    {
      provide: RandomPort,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RandomPort =>
        new SeededRandom(Number.parseInt(config.get<string>('PLATFORM_RANDOM_SEED', '42'), 10)),
    },
  ],
  exports: [ClockPort, RandomPort], // SOLO le porte
})
export class PlatformModule {}
