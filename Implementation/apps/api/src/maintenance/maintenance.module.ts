import { Module } from '@nestjs/common';

import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import { MaintenanceManager } from './maintenance.manager';
import { MaintenancePort } from './maintenance.port';

/**
 * Il modulo `maintenance` (DD §2.2, R9). Espone **solo** `MaintenancePort`.
 *
 * La Figura 2.1 gli dà tre archi: verso `IPersistenceService`, verso `INotificationService` e verso
 * `IFleetMonitorService`. Il primo c'è. Il secondo arriva con M5, quando `notifications` esisterà.
 * Il terzo qui non è un `imports` di Nest e merita una riga di spiegazione: `MaintenanceManager` usa
 * il ciclo di vita del veicolo — la classe `Robotaxi` e la sua macchina a stati — che il modulo
 * `fleet` pubblica attraverso `fleet-monitor.port.ts`, ma nessuna delle cinque operazioni di
 * `FleetMonitorPort` porta la manutenzione, quindi non c'è un provider da iniettare. È una
 * dipendenza di compilazione verso la porta di `fleet`, non un arco fra provider, ed è segnalata
 * nella pull request di M2 come imprecisione del DD §2.2 da correggere.
 */
@Module({
  imports: [PersistenceModule, PlatformModule],
  providers: [{ provide: MaintenancePort, useClass: MaintenanceManager }],
  exports: [MaintenancePort], // SOLO la porta
})
export class MaintenanceModule {}
