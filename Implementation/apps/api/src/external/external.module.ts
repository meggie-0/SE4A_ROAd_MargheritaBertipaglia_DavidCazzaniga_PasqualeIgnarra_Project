import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PlatformModule } from '../platform/platform.module';

import { ExternalServicesGateway } from './external-services.gateway';
import { ExternalServicesPort } from './external-services.port';
import { FleetSimulationPort } from './fleet-simulation.port';
import { HourlyTrafficGateway } from './hourly-traffic.gateway';
import { LinearRouteGateway } from './linear-route.gateway';
import { OsrmRouteGateway } from './osrm-route.gateway';
import { SimulatorFleetGateway } from './simulator-fleet.gateway';
import { SimulatorSchedule } from './simulator.schedule';

/**
 * Il modulo `external` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone `ExternalServicesPort` e, da M7, `FleetSimulationPort` — il comando che fa avanzare il
 * mondo simulato, che nessun componente di dominio inietta (decisione D64).
 *
 * Della prima va detto che espone **solo** operazioni verso i fornitori: chi ha bisogno di un ETA,
 * del livello di traffico, di comandare una rotta o di leggere la telemetria la inietta e non sa
 * quale adapter la stia realizzando — è ciò che ha permesso a M7 di sostituire la stima lineare con OSRM e di collegare il
 * simulatore di flotta senza che `allocation`, `rides`, `mode` o `rebalancing` cambiassero una riga
 * delle proprie decisioni (NFR8).
 *
 * I quattro adapter sono provider **interni**: non compaiono negli `exports`, quindi nessuno fuori
 * da qui può iniettarli. È la forma in cui il facade del DD §2.2 è verificabile — se un componente
 * potesse chiedere `SimulatorFleetGateway`, saprebbe che la flotta è simulata, e la sostituibilità
 * che NFR8 promette sarebbe vera solo sulla carta.
 *
 * `LinearRouteGateway` non è un doppio da test lasciato in produzione: è la **via d'uscita** di
 * `OsrmRouteGateway`, che ci ripiega quando il fornitore non è configurato o non risponde. È il
 * caso che il cancello di M7 verifica, ed è il motivo per cui il modulo funziona senza rete.
 */
@Module({
  imports: [ConfigModule, PlatformModule],
  providers: [
    LinearRouteGateway,
    OsrmRouteGateway,
    HourlyTrafficGateway,
    SimulatorFleetGateway,
    SimulatorSchedule,
    { provide: ExternalServicesPort, useClass: ExternalServicesGateway },
    // La stessa istanza dietro due nomi: l'adapter *è* il simulatore, e la seconda porta pubblica
    // di lui la sola cosa che il resto del sistema può comandargli — di avanzare.
    { provide: FleetSimulationPort, useExisting: SimulatorFleetGateway },
  ],
  exports: [ExternalServicesPort, FleetSimulationPort], // SOLO le porte
})
export class ExternalModule {}
