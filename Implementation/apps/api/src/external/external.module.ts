import { Module } from '@nestjs/common';

import { PlatformModule } from '../platform/platform.module';

import { ExternalServicesGateway } from './external-services.gateway';
import { ExternalServicesPort } from './external-services.port';
import { HourlyTrafficGateway } from './hourly-traffic.gateway';
import { LinearEtaGateway } from './linear-eta.gateway';

/**
 * Il modulo `external` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **solo** `ExternalServicesPort`. Chi ha bisogno di un ETA o del livello di traffico
 * inietta la porta e non sa quale adapter la stia realizzando: è ciò che permette a M7 di
 * sostituire `LinearEtaGateway` con l'adapter OSRM e `HourlyTrafficGateway` con la sorgente reale
 * senza che `allocation`, `rides` o `mode` cambino di una riga (NFR8).
 *
 * I due adapter sono provider **interni**: non compaiono negli `exports`, quindi nessuno fuori da
 * qui può iniettarli. È la forma in cui il facade del DD §2.2 è verificabile — se un componente
 * potesse chiedere `HourlyTrafficGateway`, saprebbe che il traffico viene dall'orologio.
 *
 * `PlatformModule` entra con M6: la stima del traffico dipende dall'ora locale, che viene da
 * `ClockPort` e mai dall'orologio di sistema (CLAUDE.md Regola 3).
 */
@Module({
  imports: [PlatformModule],
  providers: [
    LinearEtaGateway,
    HourlyTrafficGateway,
    { provide: ExternalServicesPort, useClass: ExternalServicesGateway },
  ],
  exports: [ExternalServicesPort], // SOLO la porta
})
export class ExternalModule {}
