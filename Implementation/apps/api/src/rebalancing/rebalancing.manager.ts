import { Injectable, Logger } from '@nestjs/common';
import {
  haversineKm,
  milanWeekdayHourSlot,
  nearestZone,
  type ZoneDemand,
  type ZoneCentroid,
} from '@road/shared';

import { ExternalServicesPort } from '../external/external-services.port';
import { FleetMonitorPort } from '../fleet/fleet-monitor.port';
import {
  ConcurrentTransitionError,
  IllegalTransitionError,
  type RobotaxiSnapshot,
} from '../fleet/robotaxi.port';
import { NotificationPort } from '../notifications/notification.port';
import { PersistencePort, type ZoneRecord } from '../persistence/persistence.port';
import { ClockPort } from '../platform/clock.port';

import { rankByDeficit, rankByExpectedDemand, type ZoneDemandInput } from './demand-model';
import {
  RebalancingPort,
  type DemandAnalysis,
  type RebalancingDispatch,
  type RebalancingPlan,
} from './rebalancing.port';

/**
 * Il `RebalancingManager` (DD §2.2, §2.4 Figura 2.7): stima la domanda e ci manda i veicoli fermi.
 *
 * Le due operazioni condividono l'analisi e divergono su cosa ne fanno: `analyzeDemand()` la
 * restituisce e basta, `rebalance()` la usa per decidere. Il calcolo sta in `demand-model.ts`, che è
 * fatto di funzioni pure — qui dentro c'è solo la raccolta degli ingressi e l'esecuzione delle
 * decisioni.
 *
 * La divisione serve a **leggere** la metrica della decisione D12 in un file dove non c'è I/O, non a
 * verificarla lì: `demand-model.ts` non è una porta, quindi nessun test può importarlo (HARNESS.md
 * §3) e la metrica si verifica attraverso `analyzeDemand()`, con Postgres vero. È il prezzo del
 * confine fra moduli, ed è quello giusto da pagare — un test che importasse l'interno di questo
 * modulo smetterebbe di dimostrare che il modulo è sostituibile.
 *
 * **La zona di un veicolo si calcola, non si legge.** `robotaxi.zoneId` esiste in tabella ma nessun
 * componente lo aggiorna quando un veicolo si muove: prenderlo per buono significherebbe
 * riposizionare in base a dove i veicoli erano al seed. La regola autorevole è la decisione D10 —
 * un punto appartiene alla zona il cui centroide è più vicino — ed è pura, quindi applicarla a ogni
 * ciclo costa un confronto per veicolo e non può invecchiare.
 */
@Injectable()
export class RebalancingManager extends RebalancingPort {
  private readonly logger = new Logger(RebalancingManager.name);

  constructor(
    private readonly persistence: PersistencePort,
    private readonly fleet: FleetMonitorPort,
    private readonly notifications: NotificationPort,
    private readonly clock: ClockPort,
    /**
     * Il quarto arco che la Figura 2.1 dà a questo componente, realizzato con M7.
     *
     * Serve a due cose e non a una terza: comandare la rotta verso la zona di destinazione (Figura
     * 2.7) e leggere la telemetria per sapere chi è arrivato. **Non** serve a leggere la domanda —
     * `getDemandData()` resta fuori dalla porta, e la sorgente restano `demand_sample` e
     * `demand_event` (decisioni D47 e D62).
     */
    private readonly external: ExternalServicesPort,
  ) {
    super();
  }

  async analyzeDemand(): Promise<DemandAnalysis> {
    const analyzedAt = this.clock.now();
    return { analyzedAt, zones: (await this.analyse(analyzedAt)).zones };
  }

  async rebalance(): Promise<RebalancingPlan> {
    const analyzedAt = this.clock.now();

    // Prima si chiude ciò che è finito, poi si decide cosa cominciare: un veicolo arrivato a
    // destinazione torna `AVAILABLE` e rientra fra quelli che questo stesso ciclo può contare come
    // copertura della zona in cui si trova. Nell'ordine opposto resterebbe invisibile per un giro,
    // e il ciclo manderebbe un secondo veicolo dove uno è appena arrivato.
    const completed = await this.completeArrivedRebalancing();

    const { zones, idleByZone, zoneById } = await this.analyse(analyzedAt);

    /**
     * Quanti veicoli ciascuna zona può **cedere**.
     *
     * Una zona tiene per sé quanto basta a coprire la propria domanda attesa, arrotondata per
     * eccesso, e cede il resto. L'arrotondamento è prudente di proposito: la domanda è una stima
     * frazionaria, e cedere il veicolo che serve a coprire «1,2 corse attese» scoprirebbe una zona
     * per riempirne un'altra, che è lo scambio che il riposizionamento dovrebbe evitare.
     */
    const spare = new Map<string, number>();
    for (const zone of zones) {
      spare.set(zone.zoneId, Math.max(0, zone.availableRobotaxis - Math.ceil(zone.expectedDemand)));
    }

    const dispatched: RebalancingDispatch[] = [];
    // I veicoli che questo ciclo non può più usare: già mandati, oppure sfuggiti a una corsa fra la
    // lettura e la scrittura. Vale per l'intero ciclo, non per la singola zona.
    const unavailable = new Set<string>();

    // Le zone in deficit, dalla più scoperta (decisione D12). `rankByDeficit` rompe i pareggi
    // sull'`id` crescente, quindi due esecuzioni sullo stesso stato mandano gli stessi veicoli.
    for (const target of rankByDeficit(zones)) {
      if (target.deficit <= 0) break;

      const centroid = zoneById.get(target.zoneId);
      if (centroid === undefined) continue;

      const dispatch = await this.sendNearestIdle(
        centroid,
        idleByZone,
        spare,
        unavailable,
        analyzedAt,
      );
      if (dispatch !== null) dispatched.push(dispatch);
    }

    return { analyzedAt, zones, dispatched, completed };
  }

  /**
   * Chiude il riposizionamento dei veicoli che hanno raggiunto la zona verso cui erano stati mandati
   * (transizione 9 della Figura 2.10, M7).
   *
   * Fino a M6 quella transizione non aveva nessuno che la innescasse: la sua guardia,
   * `hasReachedTargetArea()`, dipende da dove il veicolo si trova davvero, e la telemetria nasce
   * qui. Un veicolo restava in `REBALANCING` finché una corsa non lo interrompeva — allocabile, ma
   * mai contato fra gli inattivi, quindi mai più spostabile (decisione D60).
   *
   * A chiudere è questo componente e non chi legge la telemetria per le corse: chi ha mandato il
   * veicolo è chi sa dove doveva arrivare, e la riga di `rebalancing_action` che passa a `COMPLETED`
   * è sua. La revoca della rotta è ciò che impedisce al veicolo, ora disponibile, di continuare a
   * dichiararsi arrivato a una destinazione che non ha più.
   */
  private async completeArrivedRebalancing(): Promise<readonly string[]> {
    const telemetry = await this.external.readTelemetry();
    const arrived = telemetry.filter((reading) => reading.hasArrived);
    if (arrived.length === 0) return [];

    const completed: string[] = [];
    for (const reading of arrived) {
      const [action] = await this.persistence.find('rebalancing_action', {
        where: { robotaxiId: reading.robotaxiId, status: 'TRIGGERED' },
        orderBy: [{ field: 'createdAt', direction: 'desc' }, { field: 'id' }],
        limit: 1,
      });
      // Nessuna azione aperta: quel veicolo si sta muovendo per una corsa, non per un
      // riposizionamento, e non è affare di questo ciclo.
      if (action === undefined) continue;

      try {
        await this.fleet.completeRebalancing(reading.robotaxiId);
      } catch (error) {
        if (error instanceof IllegalTransitionError || error instanceof ConcurrentTransitionError) {
          /**
           * Il veicolo ha preso una corsa mentre si riposizionava (transizione 10): il
           * riposizionamento è stato **interrotto**, non completato, e la riga si chiude come tale.
           *
           * `RebalancingStatus` ha `CANCELLED` esattamente per questo caso. Lasciarla `TRIGGERED`
           * sarebbe peggio che inutile: nessun ciclo futuro potrebbe più chiuderla — la transizione
           * 9 è ammessa solo da `REBALANCING`, e da lì il veicolo se n'è andato — quindi il
           * giornale accumulerebbe azioni che dichiarano uno spostamento in corso che non esiste, e
           * ogni giro riproverebbe a chiuderle.
           */
          this.logger.log(
            `Il robotaxi ${reading.robotaxiId} non è più in riposizionamento: l'azione si chiude come annullata.`,
          );
          await this.persistence.update('rebalancing_action', action.id, { status: 'CANCELLED' });
          continue;
        }
        throw error;
      }

      /**
       * L'azione passa a `COMPLETED` e **non prende una marca di chiusura**: `RebalancingAction`
       * nel RASD §2.2.3 ha tre campi — identificatore, stato e istante di creazione — e nessun
       * istante di completamento. Aggiungerne uno qui vorrebbe dire allargare il modello di dominio
       * per un dato che nessun requisito chiede e nessuna vista mostra.
       */
      await this.persistence.update('rebalancing_action', action.id, { status: 'COMPLETED' });
      await this.external.commandRoute(reading.robotaxiId, null);
      completed.push(reading.robotaxiId);
    }

    return completed;
  }

  /**
   * Manda verso `target` il veicolo inattivo più vicino preso da una zona in surplus.
   *
   * Restituisce `null` quando non c'è niente da mandare — nessuna zona in surplus ha più veicoli da
   * cedere — oppure quando tutti i candidati sono diventati inassegnabili nel frattempo.
   *
   * Il ciclo riprova con il candidato successivo invece di arrendersi al primo intoppo, e i due
   * errori che assorbe dicono la stessa cosa da due punti di vista: fra la lettura dei veicoli
   * inattivi e questa scrittura, quel veicolo ha preso una corsa. È l'esito normale di un sistema
   * con più scrittori (NFR1), non un guasto, e la corsa di un passeggero vale più di un
   * riposizionamento previsto.
   *
   * `unavailable` è **condiviso fra le zone di un ciclo** e non locale a questa chiamata: un veicolo
   * che ha appena preso una corsa lo ha preso per tutte le zone, e riprovarci una volta per ogni
   * zona in deficit costerebbe una transizione fallita a testa senza cambiare nessun esito.
   */
  private async sendNearestIdle(
    target: ZoneRecord,
    idleByZone: ReadonlyMap<string, readonly RobotaxiSnapshot[]>,
    spare: Map<string, number>,
    unavailable: Set<string>,
    /** L'istante dell'analisi: tutte le righe di un ciclo lo condividono. */
    analyzedAt: Date,
  ): Promise<RebalancingDispatch | null> {
    for (;;) {
      const candidate = nearestSpareRobotaxi(target, idleByZone, spare, unavailable);
      if (candidate === null) return null;

      try {
        await this.fleet.requestRebalancing(candidate.robotaxi.id);
      } catch (error) {
        if (error instanceof IllegalTransitionError || error instanceof ConcurrentTransitionError) {
          this.logger.log(
            `Il robotaxi ${candidate.robotaxi.id} non è più inattivo: si passa al successivo.`,
          );
          unavailable.add(candidate.robotaxi.id);
          continue;
        }
        throw error;
      }

      // Mandato: non è più disponibile per nessun'altra zona di questo ciclo, e la zona che lo ha
      // ceduto ha un veicolo in meno da cedere. `spare` ha una voce per ogni zona di `idleByZone`,
      // e il candidato viene da una di quelle: la chiave esiste sempre.
      unavailable.add(candidate.robotaxi.id);
      spare.set(candidate.fromZoneId, (spare.get(candidate.fromZoneId) ?? 0) - 1);

      /**
       * La riga di giornale si scrive **dopo** la transizione, e non prima.
       *
       * Ciò che rende vero «questo veicolo si sta riposizionando» è la colonna di stato, che
       * `fleet` possiede (decisione D28): scrivere l'azione per prima lascerebbe, se la
       * transizione fallisse, un'azione che dichiara un movimento mai cominciato. Nell'ordine
       * scelto il caso peggiore è opposto e più benigno — un veicolo in `REBALANCING` senza riga
       * di giornale — perché è lo stato a governare le decisioni successive, non il giornale.
       */
      await this.persistence.create('rebalancing_action', {
        robotaxiId: candidate.robotaxi.id,
        targetZoneId: target.id,
        status: 'TRIGGERED',
        createdAt: analyzedAt,
      });

      /**
       * Il comando di rotta della Figura 2.7, subito dopo la transizione 8.
       *
       * L'ordine è quello del diagramma — `requestRebalancing()` e poi `commandRoute()` — e ha la
       * stessa ragione dell'ordine fra transizione e giornale: ciò che rende vero «questo veicolo si
       * sta riposizionando» è la colonna di stato. Comandare la rotta per prima manderebbe in giro
       * un veicolo che la macchina a stati potrebbe poi rifiutare di spostare.
       */
      await this.external.commandRoute(candidate.robotaxi.id, {
        from: { lat: candidate.robotaxi.lat, lon: candidate.robotaxi.lon },
        to: { lat: target.lat, lon: target.lon },
      });

      await this.notifications.update({
        kind: 'REBALANCING_STARTED',
        occurredAt: analyzedAt,
        robotaxiId: candidate.robotaxi.id,
        targetZoneId: target.id,
        targetZoneName: target.name,
      });

      return {
        robotaxiId: candidate.robotaxi.id,
        targetZoneId: target.id,
        fromZoneId: candidate.fromZoneId,
      };
    }
  }

  /**
   * Gli ingressi del ciclo, raccolti dal manager stesso (DD §2.2.1).
   *
   * Quattro letture e nessun argomento: le zone, la base storica della fascia oraria corrente, gli
   * eventi attivi in questo istante, i veicoli inattivi. Le prime tre passano da `PersistencePort`,
   * che è la lettura lecita delle tabelle di un altro modulo (decisione D44); l'ultima da
   * `FleetMonitorPort.getAvailableRobotaxis()`, perché «inattivo» è una domanda sulla flotta e la
   * risposta la dà chi possiede la macchina a stati.
   */
  private async analyse(now: Date): Promise<{
    zones: readonly ZoneDemand[];
    idleByZone: ReadonlyMap<string, readonly RobotaxiSnapshot[]>;
    zoneById: ReadonlyMap<string, ZoneRecord>;
  }> {
    /**
     * La fascia oraria è in **ora locale di Milano** (MILESTONES.md §M6).
     *
     * I profili di domanda parlano di picchi del mattino e ore serali, che sono fenomeni dell'ora
     * locale: cercare la fascia con l'ora UTC sposterebbe ogni picco di un'ora d'inverno e di due
     * d'estate. La conversione sta in `@road/shared` perché la usa anche l'adapter del traffico.
     */
    const slot = milanWeekdayHourSlot(now);

    const [zones, samples, events, idle] = await Promise.all([
      this.persistence.find('zone', { orderBy: [{ field: 'id' }] }),
      this.persistence.find('demand_sample', {
        where: { dayOfWeek: slot.dayOfWeek, hourOfDay: slot.hourOfDay },
      }),
      // Un evento è attivo se `t ∈ [inizio, fine)`: semiaperto come ogni altro intervallo del
      // sistema, così l'istante di fine non gli appartiene più (decisione D12).
      this.persistence.find('demand_event', {
        where: { startsAt: { atMost: now }, endsAt: { greaterThan: now } },
        orderBy: [{ field: 'name' }, { field: 'id' }],
      }),
      this.fleet.getAvailableRobotaxis(),
    ]);

    const baseByZone = new Map(samples.map((sample) => [sample.zoneId, sample.baseDemand]));
    const eventsByZone = new Map<string, { name: string; multiplier: number }[]>();
    for (const event of events) {
      const forZone = eventsByZone.get(event.zoneId) ?? [];
      forZone.push({ name: event.name, multiplier: event.multiplier });
      eventsByZone.set(event.zoneId, forZone);
    }

    const idleByZone = groupByZone(idle, zones);

    const inputs = zones.map((zone): ZoneDemandInput => ({
      zoneId: zone.id,
      zoneName: zone.name,
      // Una zona senza campione in questa fascia ha base zero, non «base sconosciuta»: il seed
      // copre la settimana intera, quindi l'assenza significa che a quell'ora non ci si aspetta
      // domanda. Trattarla come ignota l'avrebbe esclusa dall'ordinamento, e una zona esclusa
      // non riceve mai un veicolo.
      baseDemand: baseByZone.get(zone.id) ?? 0,
      events: eventsByZone.get(zone.id) ?? [],
      availableRobotaxis: (idleByZone.get(zone.id) ?? []).length,
    }));

    return {
      zones: rankByExpectedDemand(inputs),
      idleByZone,
      zoneById: new Map(zones.map((zone) => [zone.id, zone])),
    };
  }
}

/**
 * I veicoli inattivi raggruppati per zona di appartenenza, secondo la decisione D10.
 *
 * Un veicolo che non cade in nessuna zona — cosa che con una partizione di Voronoi accade solo se
 * l'elenco delle zone è vuoto — resta fuori da ogni gruppo, quindi non conta come copertura di
 * nessuna zona e non può essere mandato da nessuna parte.
 */
function groupByZone(
  robotaxis: readonly RobotaxiSnapshot[],
  zones: readonly ZoneCentroid[],
): ReadonlyMap<string, readonly RobotaxiSnapshot[]> {
  const grouped = new Map<string, RobotaxiSnapshot[]>();

  for (const robotaxi of robotaxis) {
    const zone = nearestZone({ lat: robotaxi.lat, lon: robotaxi.lon }, zones);
    if (zone === null) continue;
    const inZone = grouped.get(zone.id) ?? [];
    inZone.push(robotaxi);
    grouped.set(zone.id, inZone);
  }

  return grouped;
}

/**
 * Il veicolo inattivo più vicino a `target` fra quelli che stanno in una zona con veicoli da
 * cedere, pareggi sull'`id` del robotaxi crescente (decisione D12).
 *
 * Funzione pura: riceve gli insiemi già costruiti e non tocca né orologio né database. È la parte
 * della scelta che vale la pena poter leggere tutta insieme — chi può partire, da dove, e chi vince
 * a parità di distanza.
 *
 * **I candidati si ordinano per `id` prima di cercare il minimo**, e questa riga è la ragione per cui
 * l'ordinamento è totale. Senza, l'esito a parità di distanza dipenderebbe dall'ordine con cui
 * `idleByZone` restituisce le sue chiavi — cioè dall'ordine in cui le zone sono state incontrate
 * costruendo la mappa, che non è l'ordine degli `id` dei veicoli. Due veicoli equidistanti in **zone
 * diverse** verrebbero confrontati nell'ordine sbagliato, e a vincere sarebbe quello della zona
 * inserita per prima invece di quello con l'`id` minore. Ordinando prima, il primo minimo stretto
 * che si incontra è già quello giusto e non serve nessun confronto sui pareggi.
 */
function nearestSpareRobotaxi(
  target: ZoneRecord,
  idleByZone: ReadonlyMap<string, readonly RobotaxiSnapshot[]>,
  spare: ReadonlyMap<string, number>,
  excluded: ReadonlySet<string>,
): { robotaxi: RobotaxiSnapshot; fromZoneId: string } | null {
  const eligible: { robotaxi: RobotaxiSnapshot; fromZoneId: string }[] = [];

  for (const [zoneId, robotaxis] of idleByZone) {
    // Una zona in deficit non cede veicoli, e nemmeno la zona di destinazione: prendere da lì
    // sarebbe spostare un veicolo dentro la zona in cui si trova già.
    if (zoneId === target.id || (spare.get(zoneId) ?? 0) <= 0) continue;

    for (const robotaxi of robotaxis) {
      if (excluded.has(robotaxi.id)) continue;
      eligible.push({ robotaxi, fromZoneId: zoneId });
    }
  }

  eligible.sort((left, right) =>
    left.robotaxi.id < right.robotaxi.id ? -1 : left.robotaxi.id > right.robotaxi.id ? 1 : 0,
  );

  let best: { robotaxi: RobotaxiSnapshot; fromZoneId: string } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const candidate of eligible) {
    const { lat, lon } = candidate.robotaxi;
    const distance = haversineKm({ lat, lon }, target);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return best;
}
