import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PlatformModule } from '../platform/platform.module';

import { Database } from './database';
import { PersistenceManager } from './persistence.manager';
import { PersistencePort } from './persistence.port';

/**
 * Il modulo `persistence` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **solo** `PersistencePort`: entità TypeORM, `DataSource` e migrazioni restano dentro. Chi
 * ha bisogno del database inietta la porta, e riscrivere questo modulo su un'altra tecnologia non
 * costringerebbe a toccare una riga altrove — che è la proprietà che tutto l'impianto dei confini
 * esiste per garantire.
 *
 * Importa `PlatformModule` perché le marche temporali dei record vengono da `ClockPort`.
 */
@Module({
  imports: [ConfigModule, PlatformModule],
  providers: [Database, { provide: PersistencePort, useClass: PersistenceManager }],
  exports: [PersistencePort], // SOLO la porta
})
export class PersistenceModule {}
