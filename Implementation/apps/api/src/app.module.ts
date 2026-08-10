import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { GatewayModule } from './gateway/gateway.module';
import { PlatformModule } from './platform/platform.module';

/**
 * Composizione dell'applicazione.
 *
 * In M0 ci sono solo i due moduli che servono a far camminare lo scheletro: `platform`, che isola
 * tempo e casualità, e `gateway`, che pubblica l'HTTP. I manager di dominio del DD §2.2 arrivano
 * dalla milestone M1 in poi, nell'ordine di integrazione bottom-up del DD §5.2.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Il monorepo sta in Implementation/: l'API può girare con cwd sulla radice o su apps/api.
      envFilePath: ['.env', '../../.env'],
    }),
    PlatformModule,
    GatewayModule,
  ],
})
export class AppModule {}
