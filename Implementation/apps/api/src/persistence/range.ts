import type { TimeWindow } from './persistence.port';

/**
 * Conversione fra `TimeWindow` e il letterale `tstzrange` di PostgreSQL.
 *
 * TypeORM conosce `tstzrange` come tipo di colonna ma lo tratta come stringa: la traduzione la
 * facciamo qui, una volta sola, e la usa il `transformer` della colonna `period`.
 *
 * Il letterale prodotto è sempre **semiaperto** — `["…","…")` — perché è la semantica su cui si
 * regge il vincolo di esclusione: due finestre che si toccano non si sovrappongono, quindi un
 * veicolo può iniziare una corsa nell'istante in cui ne finisce un'altra.
 */

/** `["2026-05-04T09:30:00.000Z","2026-05-04T10:30:00.000Z")` */
export function formatTstzRange(window: TimeWindow): string {
  return `["${window.start.toISOString()}","${window.end.toISOString()}")`;
}

/**
 * Legge il letterale restituito da PostgreSQL.
 *
 * Il server risponde con il proprio formato (`DateStyle` ISO), per esempio
 * `["2026-05-04 09:30:00+00","2026-05-04 10:30:00+00")`: lo spazio al posto della `T` e il fuso a
 * due cifre non sono ISO 8601, e `new Date()` non è tenuto ad accettarli. La normalizzazione qui
 * sotto li riporta alla forma canonica invece di sperare nella tolleranza del motore JavaScript.
 */
export function parseTstzRange(raw: string): TimeWindow {
  const body = raw.slice(1, -1);
  const separator = splitBounds(body);
  const start = normalizeTimestamp(unquote(body.slice(0, separator)));
  const end = normalizeTimestamp(unquote(body.slice(separator + 1)));

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Intervallo tstzrange non interpretabile: ${raw}`);
  }
  return { start, end };
}

/** L'indice della virgola che separa i due estremi, ignorando quelle dentro gli apici. */
function splitBounds(body: string): number {
  let quoted = false;
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '"') quoted = !quoted;
    else if (body[i] === ',' && !quoted) return i;
  }
  throw new Error(`Intervallo tstzrange senza separatore: ${body}`);
}

const unquote = (value: string): string => value.trim().replace(/^"|"$/g, '');

function normalizeTimestamp(value: string): Date {
  const isoLike = value
    // `2026-05-04 09:30:00+00` → `2026-05-04T09:30:00+00`
    .replace(' ', 'T')
    // I secondi frazionari di PostgreSQL arrivano fino ai microsecondi; JavaScript legge i
    // millisecondi, e le cifre in più non sono ISO 8601.
    .replace(/(\.\d{3})\d+/, '$1')
    // `+00` → `+00:00`, `+0200` → `+02:00`. Senza minuti il fuso non è ISO 8601.
    .replace(/([+-]\d{2})$/, '$1:00')
    .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');

  return new Date(isoLike);
}
