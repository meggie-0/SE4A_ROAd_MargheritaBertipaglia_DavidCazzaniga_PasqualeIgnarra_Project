import { Module } from '@nestjs/common';

import { PersistenceModule } from '../persistence/persistence.module';

import { NotificationManager } from './notification.manager';
import { NotificationPort } from './notification.port';
import { NotificationSessionPort } from './session.port';

/**
 * Il modulo `notifications` (DD §2.2, CLAUDE.md Regola 1).
 *
 * Espone **due porte**, i due livelli dell'Observer del DD §2.3.3: `NotificationPort` per i
 * soggetti — `fleet` e `rides` — e `NotificationSessionPort` per il `gateway`, che apre e chiude le
 * sottoscrizioni dei client. `NotificationManager`, le classi di sessione concrete e la traduzione
 * degli eventi restano dentro.
 *
 * `useExisting` e non due `useClass`: le porte sono due, l'oggetto **deve** essere uno. Con due
 * `useClass` Nest costruirebbe due istanze, ognuna con il proprio registro di sessioni, e gli eventi
 * finirebbero in quella su cui nessun client si è registrato — un difetto che non fa fallire niente
 * e si manifesta come «le notifiche non arrivano», cioè nel modo più difficile da diagnosticare.
 *
 * `imports` contiene solo `persistence`: il manager scrive lo storico delle notifiche e risale dal
 * `ride_request` al passeggero, e non gli serve altro. In particolare **non** importa `fleet` né
 * `rides`, ed è ciò che rende il verso della dipendenza univoco: i soggetti conoscono l'observer,
 * l'observer non conosce i soggetti. L'evento di dominio è descritto con i soli tipi di
 * `@road/shared` proprio per rendere possibile questa asimmetria.
 */
@Module({
  imports: [PersistenceModule],
  providers: [
    NotificationManager,
    { provide: NotificationPort, useExisting: NotificationManager },
    { provide: NotificationSessionPort, useExisting: NotificationManager },
  ],
  exports: [NotificationPort, NotificationSessionPort], // SOLO le porte
})
export class NotificationsModule {}
