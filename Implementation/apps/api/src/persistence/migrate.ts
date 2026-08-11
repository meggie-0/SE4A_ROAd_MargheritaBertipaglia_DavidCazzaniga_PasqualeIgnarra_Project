import { runCommand } from './cli-context';
import { Database } from './database';

/**
 * `pnpm db:migrate`.
 *
 * Aprire la connessione *è* migrare: il `DataSource` nasce con `migrationsRun: true`
 * (vedi `data-source.ts`), quindi questo comando si limita ad aprirla e a raccontare che cosa
 * risulta applicato. Un percorso solo per le migrazioni significa che l'applicazione, i test di
 * integrazione e questo comando vedono per forza lo stesso schema.
 */
runCommand(async (context) => {
  const source = await context.get(Database).connection();

  const applied: ReadonlyArray<{ name: string }> = await source.query(
    `SELECT "name" FROM "migrations" ORDER BY "timestamp" ASC`,
  );

  console.log(`Migrazioni applicate: ${applied.length}`);
  for (const migration of applied) console.log(`  - ${migration.name}`);
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
