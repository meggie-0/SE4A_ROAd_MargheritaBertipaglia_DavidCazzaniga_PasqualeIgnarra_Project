import {
  NOTIFICATION_AUTH_FIELD,
  NOTIFICATION_EVENT,
  NOTIFICATIONS_NAMESPACE,
  notificationPushSchema,
  type NotificationPush,
} from '@road/shared';
import { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';

import { apiBaseUrl } from './api-base-url';

/**
 * L'iscrizione al canale push (RASD R6, G7; NFR2; DD §2.6.2).
 *
 * È ciò che rende la vista di stato *live* invece che una schermata da ricaricare: NFR2, nella
 * formulazione del DD §4.3, è soddisfatto quando «a state change reaches a connected client over
 * the push channel without the client polling». Questo hook non interroga mai il backend — apre una
 * socket, si autentica sull'handshake con lo stesso access token di M1b, e aspetta.
 *
 * **Chi riceve cosa non si decide qui.** Il `NotificationManager` interroga le sessioni registrate e
 * consegna a un passeggero solo gli eventi delle sue corse (DD §2.3.3): il client non filtra per
 * destinatario, perché un filtro lato client sarebbe una regola di dominio scritta dove chiunque
 * può disattivarla. Quello che il client fa è dividere gli eventi per corsa, che è un'altra cosa.
 *
 * Ogni messaggio viene validato con lo schema condiviso: una forma inattesa si scarta invece di
 * propagarsi nello stato dell'interfaccia.
 */

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface NotificationFeed {
  readonly notifications: readonly NotificationPush[];
  readonly connection: ConnectionState;
}

/** Quante notifiche tenere. Oltre, le più vecchie si dimenticano: nessuna schermata le mostra. */
const MAX_NOTIFICATIONS = 50;

export function useNotifications(token: string | null): NotificationFeed {
  const [notifications, setNotifications] = useState<readonly NotificationPush[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('disconnected');

  useEffect(() => {
    if (token === null) {
      setConnection('disconnected');
      setNotifications([]);
      return;
    }

    setConnection('connecting');
    const socket: Socket = io(`${apiBaseUrl}${NOTIFICATIONS_NAMESPACE}`, {
      auth: { [NOTIFICATION_AUTH_FIELD]: token },
      transports: ['websocket', 'polling'],
    });

    socket.on('connect', () => setConnection('connected'));
    socket.on('disconnect', () => setConnection('disconnected'));
    /**
     * Un handshake **rifiutato** non è una disconnessione, e senza questa riga non lo dice nessuno.
     *
     * Socket.IO emette `disconnect` quando una connessione stabilita cade, e `connect_error` quando
     * non è mai stata stabilita — che è il caso di ogni token scaduto o falso, cioè proprio quello
     * in cui l'operatore ha più bisogno di sapere che il canale non c'è. Senza gestirlo lo stato
     * resta su `connecting`, e l'indicatore mostra comunque «canale non connesso» perché tutto ciò
     * che non è `connected` finisce in quel ramo: la risposta giusta per la ragione sbagliata, che è
     * il genere di cosa che la prima riscrittura del ternario romperebbe in silenzio.
     */
    socket.on('connect_error', () => setConnection('disconnected'));
    socket.on(NOTIFICATION_EVENT, (payload: unknown) => {
      const parsed = notificationPushSchema.safeParse(payload);
      if (!parsed.success) return;
      setNotifications((previous) => [...previous, parsed.data].slice(-MAX_NOTIFICATIONS));
    });

    // La socket si chiude quando il token cambia o il componente sparisce: è la deregistrazione
    // che il DD §2.3.3 pretende, vista dal lato del client — il gateway toglie la sessione dal
    // registro del `NotificationManager` quando la connessione cade.
    return () => {
      socket.close();
    };
  }, [token]);

  return { notifications, connection };
}
