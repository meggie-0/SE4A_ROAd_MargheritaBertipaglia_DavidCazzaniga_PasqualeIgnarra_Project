import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, type EntityManager } from 'typeorm';

import { buildDataSourceOptions } from './data-source';

/**
 * La connessione al database, aperta **alla prima operazione** e non all'avvio del modulo.
 *
 * Perché pigra e non ansiosa: `AppModule` compone tutti i moduli, e i controlli che non toccano il
 * database — il cancello di M0, la generazione dell'OpenAPI — devono poter avviare l'applicazione
 * anche dove un Postgres non c'è, per esempio in CI. Con una connessione ansiosa quei controlli
 * pretenderebbero un database per verificare cose che con il database non c'entrano nulla, e
 * `pnpm verify` diventerebbe verde o rosso a seconda di che cosa gira sulla macchina.
 *
 * Il prezzo è che un `DATABASE_URL` sbagliato si scopre alla prima query invece che all'avvio. È
 * un prezzo accettabile: la prima query arriva comunque entro la prima richiesta utile, e i test
 * di integrazione la fanno nel `beforeAll`.
 */
@Injectable()
export class Database implements OnModuleDestroy {
  private source: DataSource | null = null;
  private opening: Promise<DataSource> | null = null;

  constructor(private readonly config: ConfigService) {}

  /** Il `DataSource` inizializzato, con le migrazioni già applicate. */
  async connection(): Promise<DataSource> {
    if (this.source !== null) return this.source;

    // Due chiamate concorrenti devono aprire una connessione sola: la promessa è la sezione
    // critica, e senza di essa le migrazioni partirebbero due volte in parallelo.
    this.opening ??= this.open();
    try {
      this.source = await this.opening;
    } catch (error) {
      // Un tentativo fallito non deve restare in cache: il prossimo deve poter riprovare.
      this.opening = null;
      throw error;
    }
    return this.source;
  }

  /** Esegue `work` in una transazione. È l'unico modo in cui il manager scrive più righe insieme. */
  async transaction<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    const source = await this.connection();
    return source.transaction(work);
  }

  async onModuleDestroy(): Promise<void> {
    const source = this.source;
    this.source = null;
    this.opening = null;
    if (source?.isInitialized === true) await source.destroy();
  }

  private async open(): Promise<DataSource> {
    const url = this.config.get<string>('DATABASE_URL');
    if (url === undefined || url.length === 0) {
      throw new Error(
        'DATABASE_URL non è configurata: copia .env.example in .env (vedi README) oppure ' +
          "esporta la variabile prima di avviare l'API.",
      );
    }

    const source = new DataSource(buildDataSourceOptions(url));
    await source.initialize();
    return source;
  }
}
