import { InitialSchema1786320000000 } from './1786320000000-initial-schema';

/**
 * Le migrazioni, elencate esplicitamente e in ordine.
 *
 * Non un glob: sotto ts-jest i file sono `.ts`, dopo `nest build` sono `.js`, e un glob che
 * funziona in un contesto sbaglia nell'altro — con l'effetto peggiore possibile, cioè un database
 * senza schema e un errore che parla d'altro.
 */
export const ALL_MIGRATIONS = [InitialSchema1786320000000];
