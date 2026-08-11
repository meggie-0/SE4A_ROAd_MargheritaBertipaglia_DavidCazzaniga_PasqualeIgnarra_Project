import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { FleetModule } from './fleet/fleet.module';
import { GatewayModule } from './gateway/gateway.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { PersistenceModule } from './persistence/persistence.module';
import { PlatformModule } from './platform/platform.module';

/**
 * Composizione dell'applicazione.
 *
 * I moduli entrano nell'ordine di integrazione bottom-up del DD §5.2: `platform`, che isola tempo
 * e casualità; `persistence`, la fondazione su cui poggia tutto il resto (M1); `auth`, che governa
 * account e accesso (M1b); `fleet` e `maintenance`, il modello del veicolo e il suo ciclo di vita
 * (M2); `gateway`, che pubblica l'HTTP. I manager di dominio restanti arrivano dalle milestone
 * successive.
 *
 * `fleet` e `maintenance` non pubblicano ancora endpoint: MILESTONES.md §M2 chiede il modello e le
 * porte, e i primi endpoint operatore sono previsti da M3 (lettura e cambio di strategia), che ora
 * ha i guard di M1b con cui proteggerli.
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
    AuthModule,
    FleetModule,
    MaintenanceModule,
    GatewayModule,
  ],
})
export class AppModule {}
