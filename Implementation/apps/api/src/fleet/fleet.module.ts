import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { PersistenceModule } from '../persistence/persistence.module';
import { PlatformModule } from '../platform/platform.module';

import { FleetMonitor } from './fleet-monitor';
import { FleetMonitorPort } from './fleet-monitor.port';

/**
 * Il modulo `fleet` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **solo** `FleetMonitorPort` — e, attraverso quel file, il vocabolario del ciclo di vita del
 * veicolo che il DD §2.3.2 dichiara pubblico. `FleetMonitor` e le sette classi di stato concrete
 * restano dentro.
 *
 * La Figura 2.1 dà al `FleetMonitor` anche l'arco verso `IExternalServices`, che qui **non c'è e non
 * ci sarà**. Con M7 la telemetria esiste, ma a leggerla non è questo modulo: la legge `rides`, che
 * la usa per far avanzare le corse, e ne consegna a `fleet` la sola parte che gli compete — dove
 * sono i veicoli — chiamando `recordPositions()` (decisione D61). L'arco della figura resta quindi
 * non realizzato, e il verso è quello giusto: `fleet` non deve conoscere né i fornitori né le corse.
 */
/*
 * `notifications` entra con M5: ogni `Robotaxi` che `FleetMonitor` costruisce è un `Subject` del
 * DD §2.3.3, e l'unico observer che ci registra sopra è il `NotificationManager`. L'arco va in
 * questo verso e in nessun altro — `notifications` non conosce `fleet` — che è ciò che tiene fuori
 * la dipendenza circolare e permette di provare la macchina a stati senza alzare una socket.
 */
@Module({
  imports: [PersistenceModule, PlatformModule, NotificationsModule],
  providers: [{ provide: FleetMonitorPort, useClass: FleetMonitor }],
  exports: [FleetMonitorPort], // SOLO la porta
})
export class FleetModule {}
