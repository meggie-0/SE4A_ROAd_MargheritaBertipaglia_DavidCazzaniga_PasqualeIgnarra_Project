import type { ConfigService } from '@nestjs/config';

/**
 * La configurazione del token, letta **solo** dall'ambiente (CLAUDE.md, «Cose da non fare»:
 * nessun segreto nel codice).
 *
 * Vive in un file suo perché la leggono due punti che devono restare d'accordo: `auth.module.ts`,
 * che configura chi *firma*, e `jwt.strategy.ts`, che configura chi *verifica*. Con due letture
 * indipendenti basterebbe un refuso nel nome della variabile perché il verificatore usasse un
 * segreto vuoto e accettasse token firmati da chiunque.
 */

/**
 * Lunghezza minima del segreto di firma.
 *
 * HS256 usa il segreto come chiave HMAC: sotto i 32 byte la chiave è più corta dell'output
 * dell'hash, ed è la condizione in cui una ricerca esaustiva diventa concepibile (RFC 7518 §3.2 la
 * vieta esplicitamente). Il controllo è qui e non in un commento perché un segreto assente
 * lascerebbe partire l'applicazione firmando con la stringa vuota, cioè accettando token che
 * chiunque può fabbricare — e lo scopriremmo in produzione.
 */
export const JWT_SECRET_MIN_LENGTH = 32;

/** Un'ora. Breve, perché senza stato di sessione (NFR3) non esiste modo di revocare un token. */
export const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;

/** Il segreto di firma. Fallisce all'avvio del modulo se manca o è troppo corto. */
export function readJwtSecret(config: ConfigService): string {
  const secret = config.get<string>('JWT_SECRET') ?? '';
  if (secret.length < JWT_SECRET_MIN_LENGTH) {
    throw new Error(
      `JWT_SECRET assente o più corto di ${JWT_SECRET_MIN_LENGTH} caratteri. ` +
        'Va impostato nell\'ambiente: vedi ".env.example".',
    );
  }
  return secret;
}

/** La durata dell'access token in secondi. */
export function readTokenLifetimeSeconds(config: ConfigService): number {
  const raw = config.get<string>('JWT_EXPIRES_IN_SECONDS');
  if (raw === undefined) return DEFAULT_TOKEN_LIFETIME_SECONDS;

  const seconds = Number.parseInt(raw, 10);
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(`JWT_EXPIRES_IN_SECONDS deve essere un intero positivo, non "${raw}".`);
  }
  return seconds;
}

/**
 * I cicli di bcrypt.
 *
 * Dodici è il valore corrente comunemente raccomandato: costa qualche decina di millisecondi per
 * hash, che è irrilevante su un login e proibitivo su una ricerca esaustiva. È configurabile
 * perché i test hanno bisogno di abbassarlo — con 12 cicli, una suite che registra decine di
 * utenti passerebbe più tempo dentro bcrypt che nel codice che sta verificando.
 */
export const DEFAULT_BCRYPT_ROUNDS = 12;

export function readBcryptRounds(config: ConfigService): number {
  const raw = config.get<string>('BCRYPT_ROUNDS');
  if (raw === undefined) return DEFAULT_BCRYPT_ROUNDS;

  const rounds = Number.parseInt(raw, 10);
  // Il minimo di bcrypt è 4, il massimo 31. Fuori da lì la libreria solleva, ma lo farebbe al
  // primo login invece che all'avvio.
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 31) {
    throw new Error(`BCRYPT_ROUNDS deve essere un intero fra 4 e 31, non "${raw}".`);
  }
  return rounds;
}
