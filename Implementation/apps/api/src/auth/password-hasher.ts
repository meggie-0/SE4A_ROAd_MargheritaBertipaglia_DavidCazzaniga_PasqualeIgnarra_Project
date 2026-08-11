import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcrypt';

import { readBcryptRounds } from './jwt.config';

/**
 * L'unico punto del sistema in cui una password in chiaro viene toccata.
 *
 * bcrypt e non un hash generico: incorpora il sale nel risultato — quindi non esiste una colonna
 * `salt` da dimenticare — ed è deliberatamente lento, che è la proprietà che serve contro chi
 * provasse una lista di password su un database rubato.
 *
 * Nessun metodo di questa classe registra alcunché: la password non compare nei log perché non
 * esiste una riga che la scriva, non perché qualcuno si ricorda di filtrarla.
 */
@Injectable()
export class PasswordHasher {
  private readonly rounds: number;

  constructor(config: ConfigService) {
    this.rounds = readBcryptRounds(config);
  }

  hash(plaintext: string): Promise<string> {
    return hash(plaintext, this.rounds);
  }

  /**
   * Se la password corrisponde all'hash.
   *
   * `bcrypt.compare` confronta in tempo costante rispetto al contenuto: due hash che differiscono
   * al primo byte e due che differiscono all'ultimo impiegano lo stesso tempo, quindi la durata
   * della risposta non dice quanto ci si è andati vicino.
   */
  matches(plaintext: string, passwordHash: string): Promise<boolean> {
    return compare(plaintext, passwordHash);
  }
}
