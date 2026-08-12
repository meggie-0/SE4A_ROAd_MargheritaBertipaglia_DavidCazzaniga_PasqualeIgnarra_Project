/**
 * La **seconda porta** di `external`: far avanzare il mondo simulato (M7).
 *
 * `external` espone due porte come `platform` e `mode`, e la divisione è netta:
 *
 * - `external-services.port.ts` è il **servizio**: ciò che ROAd chiede ai sistemi che non
 *   controlla — tempi di arrivo, traffico, comandi di rotta, telemetria. Chi la inietta non sa se
 *   dietro ci sia OSRM o un foglio di calcolo, e nemmeno se la flotta esista davvero;
 * - questo file è il **comando al simulatore**, e dice apertamente ciò che l'altra porta nasconde:
 *   in questo prototipo la flotta è finta, e il tempo in cui si muove non è quello di sistema.
 *
 * **Perché una porta e non un metodo interno.** MILESTONES.md §M7 chiede che il simulatore «sotto
 * test avanzi solo su `tick()` esplicito», e CLAUDE.md Regola 1 dice che i test raggiungono un
 * modulo solo dalle sue porte — nemmeno i test hanno più diritto di accesso di un altro modulo
 * (HARNESS.md §3). Le due regole insieme lasciano una sola forma possibile: il tick è un'operazione
 * pubblica del modulo. È la stessa ragione per cui `TrafficMonitorPort` esiste separata da
 * `ModePort` (decisione D64).
 *
 * **Nessun componente di dominio la inietta, e non deve.** I suoi due chiamanti sono lo scheduler
 * di `external`, che in esecuzione normale le dà il ritmo, e i test, che avanzano un tick alla
 * volta. Un manager che la iniettasse starebbe comandando al mondo di muoversi, che non è una cosa
 * che un sistema di gestione flotta possa fare — e il giorno in cui i veicoli fossero veri, questa
 * porta sparirebbe insieme al simulatore senza che nient'altro se ne accorga (NFR8).
 */
export abstract class FleetSimulationPort {
  /**
   * Avanza il mondo simulato di `times` passi.
   *
   * Un passo vale `SIMULATOR_TICK_MINUTES` minuti di mondo, percorsi alla velocità di crociera
   * configurata: quanti ne servano per arrivare da qualche parte è quindi una divisione, ed è ciò
   * che permette al cancello di M7 di pretendere «un numero **deterministico** di tick» invece di
   * aspettare che qualcosa accada.
   *
   * Non tocca né l'orologio né il database: muove veicoli finti. Le conseguenze — le posizioni in
   * tabella, le transizioni, le notifiche — arrivano quando qualcuno **legge** la telemetria, che è
   * un'altra operazione con un altro chiamante.
   */
  abstract tick(times?: number): void;

  /**
   * Dimentica tutti i veicoli: il mondo simulato torna vuoto.
   *
   * Esiste per una ragione sola, e vale la pena scriverla invece di lasciarla dedurre. Il
   * simulatore è **la flotta**, non una vista del database: le posizioni dei veicoli vivono nella
   * sua memoria e sopravvivono a qualunque cosa accada alle tabelle. È il comportamento giusto in
   * esecuzione — svuotare il database non fa sparire i veicoli dalla strada — ed è esattamente ciò
   * che rende una suite dipendente dall'ordine di esecuzione, che HARNESS.md §2 vieta: un test che
   * riparte da un database pulito troverebbe i veicoli dove li ha lasciati il test precedente.
   *
   * Chi la chiama è quindi l'harness dei test, insieme al `TRUNCATE`. In esecuzione normale non la
   * chiama nessuno, e con veicoli veri sparirebbe insieme al simulatore.
   */
  abstract reset(): void;
}
