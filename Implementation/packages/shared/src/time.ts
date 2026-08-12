/**
 * L'ora locale di Milano, calcolata da un istante assoluto.
 *
 * Sta in `packages/shared` per la stessa ragione di `geo.ts`: serve a più moduli del backend che
 * non possono importarsi a vicenda (CLAUDE.md Regola 1) — `rebalancing` per trovare la fascia
 * oraria di `demand_sample`, `external` per stimare il traffico — e, da M8, alla dashboard che
 * mostra l'analisi della domanda. Sono funzioni **pure**: ricevono l'istante, non lo leggono.
 * L'istante viene sempre da `ClockPort.now()` (CLAUDE.md Regola 3).
 *
 * **Perché la conversione esiste.** Le fasce di `demand_sample` sono in ora locale di Milano e non
 * in UTC (MILESTONES.md §M1): i profili di domanda descrivono «picchi del mattino» e «ore serali»,
 * che sono fenomeni dell'ora locale. Indicizzare su UTC sposterebbe ogni picco di un'ora d'inverno
 * e di due d'estate, cioè renderebbe il modello di domanda sbagliato per metà anno — e sbagliato
 * in un modo che nessun test scritto d'inverno noterebbe.
 */

/** Il fuso della città su cui opera il prototipo. */
export const MILAN_TIME_ZONE = 'Europe/Rome';

/**
 * Giorno della settimana e ora del giorno in ora locale di Milano.
 *
 * `dayOfWeek` usa la numerazione di JavaScript — 0 = domenica … 6 = sabato — che è la stessa con
 * cui il seed ha scritto `demand_sample.dayOfWeek`.
 */
export interface WeekdayHourSlot {
  readonly dayOfWeek: number;
  readonly hourOfDay: number;
}

/** Da nome inglese abbreviato del giorno alla numerazione di JavaScript. */
const DAY_NUMBER: Readonly<Record<string, number>> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Il formattatore, costruito una volta sola.
 *
 * `hourCycle: 'h23'` e non `hour12: false`: le due opzioni sembrano equivalenti e non lo sono —
 * con `hour12: false` diverse versioni di ICU rendono la mezzanotte come `24` invece che come `00`,
 * e la fascia oraria finirebbe fuori dall'intervallo `0..23` esattamente una volta al giorno. È il
 * genere di difetto che passa ogni prova tranne quella notturna.
 *
 * La localizzazione è `en-US` perché ciò che si legge sono i nomi dei giorni della tabella qui
 * sopra: la lingua dell'interfaccia non c'entra, questo è un calcolo.
 */
const MILAN_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: MILAN_TIME_ZONE,
  weekday: 'short',
  hour: '2-digit',
  hourCycle: 'h23',
});

/**
 * La fascia oraria settimanale a cui l'istante appartiene, in ora locale di Milano.
 *
 * Solleva se il runtime non sa convertire il fuso, invece di ripiegare su UTC: un ripiego
 * silenzioso darebbe risposte plausibili e sbagliate per mezz'anno, mentre un errore all'avvio si
 * nota subito. Node con ICU completo — la configurazione predefinita dalla versione 13 — lo sa
 * fare sempre.
 */
export function milanWeekdayHourSlot(instant: Date): WeekdayHourSlot {
  const parts = MILAN_PARTS.formatToParts(instant);
  const weekday = parts.find((part) => part.type === 'weekday')?.value;
  const hour = parts.find((part) => part.type === 'hour')?.value;

  const dayOfWeek = weekday === undefined ? undefined : DAY_NUMBER[weekday];
  const hourOfDay = hour === undefined ? Number.NaN : Number.parseInt(hour, 10);

  if (dayOfWeek === undefined || !Number.isInteger(hourOfDay)) {
    throw new Error(
      `Ora locale di ${MILAN_TIME_ZONE} non calcolabile per ${instant.toISOString()}.`,
    );
  }

  return { dayOfWeek, hourOfDay };
}

/** Vero nel fine settimana, quando i profili pendolari non valgono. */
export function isWeekend(slot: WeekdayHourSlot): boolean {
  return slot.dayOfWeek === 0 || slot.dayOfWeek === 6;
}
