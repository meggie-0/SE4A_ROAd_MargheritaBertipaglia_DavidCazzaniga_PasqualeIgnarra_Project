import { Injectable } from '@nestjs/common';

import {
  PersistencePort,
  RecordNotFoundError,
  UniqueConstraintError,
  type PersistedRecord,
  type RecordPatch,
} from '../persistence/persistence.port';

import {
  AuthPort,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  UnknownUserError,
  type AccountProfile,
  type AuthResult,
  type Credentials,
  type ProfileUpdate,
  type RegisterInput,
} from './auth.port';
import { PasswordHasher } from './password-hasher';
import { TokenIssuer } from './token-issuer';

/**
 * L'`AuthenticationManager` (DD §2.2): account e autenticazione (R1, R2).
 *
 * Non tiene niente in memoria. Non c'è una mappa delle sessioni, non c'è una cache degli utenti,
 * non c'è un elenco di token emessi: tutto ciò che dura sta in `user`, e tutto ciò che identifica
 * chi chiama sta nel token. È la forma operativa di NFR3 (DD §4.3) — un token emesso da
 * un'istanza è accettato da una seconda che non ha visto il login — ed è anche il motivo per cui
 * questa classe non implementa la verifica dei token: quella non ha bisogno di lui, e passa dai
 * guard di `access-control.port.ts`.
 *
 * La password in chiaro esiste solo come argomento di `register`, `authenticate` e
 * `updateProfile`, e da lì entra unicamente in `PasswordHasher`. Non viene mai scritta in un
 * record, non viene mai registrata, e non esce da nessun metodo: `profileOf()` elenca i campi che
 * possono uscire invece di togliere quelli vietati.
 */
@Injectable()
export class AuthManager extends AuthPort {
  constructor(
    private readonly persistence: PersistencePort,
    private readonly passwords: PasswordHasher,
    private readonly tokens: TokenIssuer,
  ) {
    super();
  }

  async register(input: RegisterInput): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const passwordHash = await this.passwords.hash(input.password);

    let created: PersistedRecord<'user'>;
    try {
      created = await this.persistence.create('user', {
        email,
        passwordHash,
        name: input.name,
        surname: input.surname,
        phoneNumber: input.phoneNumber,
        role: input.role,
      });
    } catch (error) {
      // `user` ha un solo vincolo di unicità, sull'indirizzo. Se un giorno ne avesse un secondo,
      // questa traduzione direbbe la cosa sbagliata: è il motivo per cui `UniqueConstraintError`
      // porta con sé il nome del vincolo.
      if (error instanceof UniqueConstraintError) throw new EmailAlreadyRegisteredError(email);
      throw error;
    }

    return this.resultFor(created);
  }

  async authenticate(credentials: Credentials): Promise<AuthResult> {
    const email = normalizeEmail(credentials.email);
    const [found] = await this.persistence.find('user', { where: { email }, limit: 1 });

    // Se l'indirizzo non esiste si confronta comunque, contro un hash finto. Sembra uno spreco ed
    // è ciò che rende vera la promessa della porta: senza, un indirizzo sconosciuto risponderebbe
    // in un millisecondo e uno noto in qualche decina — bcrypt è lento per costruzione — e la
    // durata della risposta direbbe a chiunque quali indirizzi sono registrati, rendendo inutile
    // l'aver usato lo stesso messaggio d'errore per i due casi.
    const passwordHash = found?.passwordHash ?? DUMMY_PASSWORD_HASH;
    const matches = await this.passwords.matches(credentials.password, passwordHash);

    if (found === undefined || !matches) throw new InvalidCredentialsError();

    return this.resultFor(found);
  }

  async updateProfile(userId: string, patch: ProfileUpdate): Promise<AccountProfile> {
    const email = patch.email === undefined ? undefined : normalizeEmail(patch.email);

    const changes: RecordPatch<'user'> = {
      // Assegnare `undefined` a una chiave non è come ometterla, ma `RecordPatch` è un `Partial`
      // e `buildWhere`/`update` saltano i valori indefiniti: un campo non indicato resta com'è.
      ...(email === undefined ? {} : { email }),
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.surname === undefined ? {} : { surname: patch.surname }),
      // `null` è un valore, non un'assenza: cancella il numero di telefono.
      ...(patch.phoneNumber === undefined ? {} : { phoneNumber: patch.phoneNumber }),
      ...(patch.password === undefined
        ? {}
        : { passwordHash: await this.passwords.hash(patch.password) }),
    };

    try {
      return profileOf(await this.persistence.update('user', userId, changes));
    } catch (error) {
      // Un token ancora valido il cui account non c'è più: è il caso che nessuna sessione lato
      // server potrebbe segnalare prima, ed è il prezzo — noto — di non averne (NFR3).
      if (error instanceof RecordNotFoundError) throw new UnknownUserError(userId);
      if (error instanceof UniqueConstraintError) {
        throw new EmailAlreadyRegisteredError(email ?? '');
      }
      throw error;
    }
  }

  /** Profilo più token: la coppia con cui si esce da `register` e da `authenticate`. */
  private async resultFor(record: PersistedRecord<'user'>): Promise<AuthResult> {
    const user = profileOf(record);
    return {
      user,
      token: await this.tokens.issue({ id: user.id, email: user.email, role: user.role }),
    };
  }
}

/**
 * Un hash bcrypt di una password che nessun account ha, usato solo per pareggiare i tempi di
 * `authenticate` quando l'indirizzo non esiste.
 *
 * Non è un segreto e non apre nulla: è il risultato di `bcrypt.hash()` su una stringa casuale
 * scartata subito dopo. Sta nel codice perché deve essere una costante — generarne uno nuovo a
 * ogni avvio costerebbe un hash all'avvio e non cambierebbe nulla.
 */
const DUMMY_PASSWORD_HASH = '$2b$12$AJ5xKmqcAN9MadkWiDAEdeA0zxAxyFKvLRoqOIZrQ7dKgEomUPki2';

/**
 * L'indirizzo in forma canonica.
 *
 * La stessa normalizzazione dello schema Zod di `packages/shared`, ripetuta qui perché la porta si
 * raggiunge anche senza passare da HTTP — il seed lo fa. Se le due divergessero, un account creato
 * dal seed con l'indirizzo in maiuscolo non si troverebbe più al login.
 */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Dal record persistito al profilo pubblico.
 *
 * I campi sono elencati uno per uno e non è uno spread meno `passwordHash`. Uno spread
 * compilerebbe lo stesso — un oggetto più largo è assegnabile a uno più stretto quando non è un
 * letterale — e il giorno in cui `user` prendesse una colonna sensibile in più se la porterebbe
 * fuori senza che nulla protesti. È la stessa ragione per cui `robotaxiSnapshotOf` è scritta così.
 */
function profileOf(record: PersistedRecord<'user'>): AccountProfile {
  return {
    id: record.id,
    email: record.email,
    name: record.name,
    surname: record.surname,
    phoneNumber: record.phoneNumber,
    role: record.role,
    createdAt: record.createdAt,
  };
}
