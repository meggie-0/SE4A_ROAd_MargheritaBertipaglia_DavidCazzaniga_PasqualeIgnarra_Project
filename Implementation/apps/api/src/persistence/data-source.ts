import type { DataSourceOptions } from 'typeorm';

import { ALL_ENTITIES } from './entities';
import { ALL_MIGRATIONS } from './migrations';

/**
 * Le opzioni del `DataSource`, in un posto solo.
 *
 * `synchronize` è **false** e resta tale: lo schema lo definiscono le migrazioni, che sono
 * revisionabili in una pull request e riproducibili su ogni ambiente. `synchronize: true` avrebbe
 * silenziosamente saltato il vincolo di esclusione — TypeORM non sa esprimerlo — cioè proprio
 * l'invariante che questa milestone esiste per garantire.
 *
 * `migrationsRun` è **true**: la connessione porta con sé lo schema aggiornato. È ciò che rende
 * `pnpm db:migrate` una semplice apertura di connessione e ciò che permette a un test di
 * integrazione di partire da un container vuoto senza passi manuali.
 */
export function buildDataSourceOptions(url: string): DataSourceOptions {
  return {
    type: 'postgres',
    url,
    entities: ALL_ENTITIES,
    migrations: ALL_MIGRATIONS,
    migrationsRun: true,
    synchronize: false,
    logging: false,
  };
}
