import { Module } from '@nestjs/common';

import { ExternalServicesPort } from './external-services.port';
import { LinearEtaGateway } from './linear-eta.gateway';

/**
 * Il modulo `external` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **solo** `ExternalServicesPort`. Chi ha bisogno di un ETA inietta la porta e non sa quale
 * adapter la stia realizzando: è ciò che permette a M7 di sostituire `LinearEtaGateway` con
 * l'adapter OSRM senza che `allocation` cambi di una riga (NFR8).
 *
 * Il modulo non importa nulla: la stima lineare è una funzione delle sole coordinate, quindi non
 * ha bisogno né di `persistence` né di `platform`. Gli adapter di M7 avranno una cache e una
 * configurazione, e allora gli import compariranno.
 */
@Module({
  providers: [{ provide: ExternalServicesPort, useClass: LinearEtaGateway }],
  exports: [ExternalServicesPort], // SOLO la porta
})
export class ExternalModule {}
