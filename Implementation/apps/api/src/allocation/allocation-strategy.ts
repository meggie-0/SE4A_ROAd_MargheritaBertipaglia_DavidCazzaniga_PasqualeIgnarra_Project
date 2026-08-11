import type { GeoPoint, StrategyName } from '@road/shared';

import type { RobotaxiSnapshot } from '../fleet/robotaxi.port';

/**
 * Il pattern **Strategy** (DD §2.3.1 Figura 2.2, §2.6.1; CLAUDE.md Regola 2).
 *
 * Una classe astratta e non un'interfaccia TypeScript, per due ragioni che valgono entrambe:
 * un'interfaccia sparisce alla compilazione e non potrebbe fare da token di iniezione a Nest, e —
 * più importante — il pattern dev'essere **leggibile aprendo il codice**, non deducibile dalla
 * configurazione. Aprendo questo file si vede la strategia astratta; aprendo `allocation.module.ts`
 * si vede l'elenco delle concrete; aprendo `allocation.manager.ts` si vede il contesto che delega.
 */
export abstract class AllocationStrategy {
  /**
   * Il nome con cui la strategia è selezionabile.
   *
   * Sta sulla strategia e non in una tabella dentro il manager: è la strategia a sapere come si
   * chiama, e il registro si costruisce da qui. Senza, il manager avrebbe una mappa
   * nome → classe da aggiornare a ogni politica nuova, cioè esattamente la modifica che NFR7
   * vieta.
   */
  abstract readonly name: StrategyName;

  /**
   * Il veicolo scelto fra i candidati, o `null` se nessuno è idoneo.
   *
   * `null` è un esito previsto e non un errore: il RASD (Figura 3.1, ramo `[request rejected]`)
   * richiede che una richiesta senza veicolo disponibile venga rifiutata, e il DD §2.2.1 ha
   * allargato per questo il tipo di ritorno di `allocate()`.
   *
   * I candidati arrivano **già filtrati**: sono in uno stato allocabile (`FleetMonitor`) e liberi
   * nella finestra richiesta (`PersistencePort.filterAvailable`, M4). Una strategia non rilegge
   * quei fatti — sceglie, e nient'altro. È ciò che la rende sostituibile da sola.
   *
   * Asincrona perché una politica può aver bisogno di un servizio esterno: `MinimumEtaStrategy`
   * chiede gli ETA a `ExternalServicesPort`. `NearestAvailableStrategy` non ne ha bisogno e
   * restituisce una promessa già risolta, il che è il prezzo — modesto — di avere una sola firma.
   */
  abstract selectRobotaxi(
    request: AllocationRequest,
    candidates: readonly RobotaxiSnapshot[],
  ): Promise<RobotaxiSnapshot | null>;
}

/**
 * Ciò che una strategia deve sapere della richiesta per scegliere: il punto di prelievo.
 *
 * Il DD §2.3.1 scrive `selectRobotaxi(request: RideRequest, candidates)`, ma `RideRequest` come
 * oggetto di dominio nasce con `rides` in M4 — la stessa situazione in cui M2 si è trovata con
 * `RideAssignment`, e la stessa risposta: il tipo porta i soli dati che le operazioni usano
 * davvero. Entrambe le metriche del DD (distanza dal prelievo, ETA verso il prelievo, Figura 2.5)
 * guardano il punto di prelievo e nient'altro; la destinazione non entra nella scelta del veicolo,
 * e l'orario di una prenotazione anticipata è già stato usato a monte per filtrare i candidati.
 *
 * Una politica futura che avesse bisogno di più — la destinazione, la carica residua — allargherà
 * questo tipo. È un cambiamento della porta, non dei manager, e resta compatibile con NFR7: né
 * `AllocationManager` né `RideRequestManager` guardano dentro la richiesta.
 */
export interface AllocationRequest {
  readonly pickup: GeoPoint;
}

/**
 * Il candidato con il proprio punteggio, dove **il minore vince**.
 *
 * Distanza e ETA sono entrambe misure da minimizzare, quindi una sola funzione di scelta basta a
 * tutte e due le strategie.
 */
export interface ScoredCandidate {
  readonly robotaxi: RobotaxiSnapshot;
  readonly score: number;
}

/**
 * Il candidato con il punteggio minore; a parità, quello con l'`id` lessicograficamente minore.
 *
 * **La regola di pareggio non è un dettaglio.** Due veicoli fermi nello stesso punto, o due ETA
 * identici, sono casi ordinari in una flotta simulata; senza una regola totale l'esito
 * dipenderebbe dall'ordine in cui il database ha restituito le righe, e i test diventerebbero
 * instabili — che è peggio di nessun test, perché porta a modificare codice sano inseguendo
 * fallimenti che non esistono (CLAUDE.md Regola 3). MILESTONES.md §M3 chiede che la regola sia
 * deterministica *e documentata*: è questa, ed è la stessa con cui si decide la zona di un punto
 * (decisione D10) e la scelta del veicolo da riposizionare (decisione D12).
 *
 * Un punteggio non finito (`NaN`, infinito) non è confrontabile in modo totale, quindi il
 * candidato che lo porta non è idoneo e viene lasciato fuori.
 */
export function bestScored(scored: readonly ScoredCandidate[]): RobotaxiSnapshot | null {
  let best: ScoredCandidate | null = null;

  for (const candidate of scored) {
    if (!Number.isFinite(candidate.score)) continue;

    const better = best === null || candidate.score < best.score;
    const tie =
      best !== null && candidate.score === best.score && candidate.robotaxi.id < best.robotaxi.id;

    if (better || tie) best = candidate;
  }

  return best?.robotaxi ?? null;
}
