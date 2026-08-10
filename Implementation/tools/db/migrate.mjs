// `pnpm db:migrate`.
//
// Le migrazioni TypeORM (schema, estensione btree_gist, vincolo di esclusione sulle riserve)
// sono il contenuto di M1: in M0 esiste solo il comando, perché il README lo cita fra i passi di
// installazione e un comando che non esiste è peggio di uno che dice cosa manca.

console.log('Nessuna migrazione da applicare: lo schema arriva con M1 (MILESTONES.md §M1).');
console.log('Il database di sviluppo si alza comunque con `docker compose up -d`.');
