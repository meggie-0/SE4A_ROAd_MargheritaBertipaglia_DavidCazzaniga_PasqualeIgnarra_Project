import { Module, type INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { PersistenceModule } from './persistence.module';

/**
 * Il contesto Nest minimo che serve a `pnpm db:migrate` e `pnpm db:seed`.
 *
 * I due comandi vivono **dentro** il modulo `persistence` e non in `tools/`, perché migrazioni e
 * dati di partenza sono affari suoi: un file fuori dal modulo che li raggiungesse dovrebbe
 * attraversare il confine e importarne gli interni, cioè esattamente ciò che CLAUDE.md Regola 1
 * vieta. `tools/db/*.mjs` restano il punto d'ingresso, ma si limitano a lanciare questi entry
 * point compilati.
 */
@Module({
  imports: [
    // Il monorepo sta in Implementation/: i comandi possono girare con cwd sulla radice o su
    // apps/api, come già fa `AppModule`.
    ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env', '../../.env'] }),
    PersistenceModule,
  ],
})
class PersistenceCliModule {}

export function openPersistenceContext(): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(PersistenceCliModule, { logger: ['error', 'warn'] });
}

/** Esegue `work` sul contesto e lo chiude comunque vada, uscendo con 1 se qualcosa fallisce. */
export async function runCommand(
  work: (context: INestApplicationContext) => Promise<void>,
): Promise<void> {
  const context = await openPersistenceContext();
  try {
    await work(context);
  } finally {
    await context.close();
  }
}
