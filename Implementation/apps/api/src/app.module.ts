import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { GatewayModule } from './gateway/gateway.module';
import { PersistenceModule } from './persistence/persistence.module';
import { PlatformModule } from './platform/platform.module';

/**
 * Composizione dell'applicazione.
 *
 * I moduli entrano nell'ordine di integrazione bottom-up del DD §5.2: `platform`, che isola tempo
 * e casualità; `persistence`, la fondazione su cui poggia tutto il resto (M1); `gateway`, che
 * pubblica l'HTTP. I manager di dominio del DD §2.2 arrivano dalle milestone successive.
 *
 * `PersistenceModule` non apre la connessione all'avvio (vedi `persistence/database.ts`): comporre
 * l'applicazione non richiede un database, e i controlli che con il database non c'entrano —
 * il cancello di M0, la generazione dell'OpenAPI — restano eseguibili ovunque.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Il monorepo sta in Implementation/: l'API può girare con cwd sulla radice o su apps/api.
      envFilePath: ['.env', '../../.env'],
    }),
    PlatformModule,
    PersistenceModule,
    GatewayModule,
  ],
})
export class AppModule {}
