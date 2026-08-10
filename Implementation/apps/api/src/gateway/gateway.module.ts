import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PlatformModule } from '../platform/platform.module';
import { HealthController } from './health.controller';

/**
 * API Gateway (DD §2.2): unico punto d'ingresso dei client.
 *
 * Importa soltanto porte di altri moduli e non espone nulla di proprio: da qui in avanti ogni
 * milestone aggiunge controller che delegano a una porta, mai logica di dominio.
 */
@Module({
  imports: [ConfigModule, PlatformModule],
  controllers: [HealthController],
})
export class GatewayModule {}
