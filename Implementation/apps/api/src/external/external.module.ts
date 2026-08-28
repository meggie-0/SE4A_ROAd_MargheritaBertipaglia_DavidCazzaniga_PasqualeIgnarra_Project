import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { ClockPort } from '../platform/clock.port';
import { PlatformModule } from '../platform/platform.module';

import { ExternalServicesGateway } from './external-services.gateway';
import { ExternalServicesPort } from './external-services.port';
import { FleetSimulationPort } from './fleet-simulation.port';
import { HourlyTrafficGateway } from './hourly-traffic.gateway';
import { LinearRouteGateway } from './linear-route.gateway';
import { OsrmRouteGateway } from './osrm-route.gateway';
import { DEFAULT_TRAFFIC_SCRIPT, ScriptedTrafficGateway } from './scripted-traffic.gateway';
import { SimulatorFleetGateway } from './simulator-fleet.gateway';
import { SimulatorSchedule } from './simulator.schedule';
import { TrafficSource } from './traffic-source';

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
    /**
     * **Quale sorgente di traffico risponde, deciso da configurazione** (decisione D76).
     *
     * `TRAFFIC_SOURCE=scripted` sostituisce la deduzione dall'ora locale con una tabella oraria
     * relativa all'avvio del processo, che è ciò che rende dimostrabile lo scenario 3. Qualunque
     * altro valore — compresa l'assenza — lascia l'adapter orario, quindi un'installazione che non
     * sa niente di questa variabile si comporta come prima.
     *
     * La scelta sta **qui e non dentro il facade**: `ExternalServicesGateway` inietta
     * `TrafficSource` e non sa quale delle due classi stia rispondendo, che è la stessa opacità che
     * ha `OsrmRouteGateway` verso il proprio ripiego. Nessuno dei due adapter compare negli
     * `exports`, quindi nessun componente di dominio può nemmeno chiedere di saperlo (NFR8).
     */
    {
      provide: TrafficSource,
      inject: [ConfigService, ClockPort],
      useFactory: (config: ConfigService, clock: ClockPort): TrafficSource =>
        config.get<string>('TRAFFIC_SOURCE')?.trim().toLowerCase() === 'scripted'
          ? new ScriptedTrafficGateway(
              clock,
              config.get<string>('TRAFFIC_SCRIPT') ?? DEFAULT_TRAFFIC_SCRIPT,
            )
          : new HourlyTrafficGateway(clock),
    },
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
