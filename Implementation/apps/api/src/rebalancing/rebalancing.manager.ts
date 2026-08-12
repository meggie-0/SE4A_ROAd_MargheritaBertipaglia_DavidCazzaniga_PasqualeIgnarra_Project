import { Injectable, Logger } from '@nestjs/common';
import {
  haversineKm,
  milanWeekdayHourSlot,
  nearestZone,
  type ZoneDemand,
  type ZoneCentroid,
} from '@road/shared';

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
 * decisioni. La divisione è quella che rende verificabile la metrica della decisione D12 senza un
 * database, e la lettura delle righe giuste senza rifare la metrica.
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
  ) {
    super();
  }

  async analyzeDemand(): Promise<DemandAnalysis> {
    const analyzedAt = this.clock.now();
    return { analyzedAt, zones: (await this.analyse(analyzedAt)).zones };
  }

  async rebalance(): Promise<RebalancingPlan> {
    const analyzedAt = this.clock.now();
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
    const sent = new Set<string>();

    // Le zone in deficit, dalla più scoperta (decisione D12). `rankByDeficit` rompe i pareggi
    // sull'`id` crescente, quindi due esecuzioni sullo stesso stato mandano gli stessi veicoli.
    for (const target of rankByDeficit(zones)) {
      if (target.deficit <= 0) break;

      const centroid = zoneById.get(target.zoneId);
      if (centroid === undefined) continue;

      const dispatch = await this.sendNearestIdle(centroid, idleByZone, spare, sent, analyzedAt);
      if (dispatch !== null) dispatched.push(dispatch);
    }

    return { analyzedAt, zones, dispatched };
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
   */
  private async sendNearestIdle(
    target: ZoneRecord,
    idleByZone: ReadonlyMap<string, readonly RobotaxiSnapshot[]>,
    spare: Map<string, number>,
    sent: Set<string>,
    /** L'istante dell'analisi: tutte le righe di un ciclo lo condividono. */
    analyzedAt: Date,
  ): Promise<RebalancingDispatch | null> {
    const excluded = new Set(sent);

    for (;;) {
      const candidate = nearestSpareRobotaxi(target, idleByZone, spare, excluded);
      if (candidate === null) return null;

      try {
        await this.fleet.requestRebalancing(candidate.robotaxi.id);
      } catch (error) {
        if (error instanceof IllegalTransitionError || error instanceof ConcurrentTransitionError) {
          this.logger.log(
            `Il robotaxi ${candidate.robotaxi.id} non è più inattivo: si passa al successivo.`,
          );
          excluded.add(candidate.robotaxi.id);
          continue;
        }
        throw error;
      }

      sent.add(candidate.robotaxi.id);
      spare.set(candidate.fromZoneId, (spare.get(candidate.fromZoneId) ?? 1) - 1);

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
 */
function nearestSpareRobotaxi(
  target: ZoneRecord,
  idleByZone: ReadonlyMap<string, readonly RobotaxiSnapshot[]>,
  spare: ReadonlyMap<string, number>,
  excluded: ReadonlySet<string>,
): { robotaxi: RobotaxiSnapshot; fromZoneId: string } | null {
  let best: { robotaxi: RobotaxiSnapshot; fromZoneId: string } | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const [zoneId, robotaxis] of idleByZone) {
    // Una zona in deficit non cede veicoli, e nemmeno la zona di destinazione: prendere da lì
    // sarebbe spostare un veicolo dentro la zona in cui si trova già.
    if (zoneId === target.id || (spare.get(zoneId) ?? 0) <= 0) continue;

    for (const robotaxi of robotaxis) {
      if (excluded.has(robotaxi.id)) continue;

      const distance = haversineKm({ lat: robotaxi.lat, lon: robotaxi.lon }, target);
      const closer = distance < bestDistance;
      const tie = distance === bestDistance && best !== null && robotaxi.id < best.robotaxi.id;
      if (closer || tie) {
        best = { robotaxi, fromZoneId: zoneId };
        bestDistance = distance;
      }
    }
  }

  return best;
}
