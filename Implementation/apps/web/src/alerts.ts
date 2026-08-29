import type { NotificationPush, OperatorAlert } from '@road/shared';

/**
 * Quali eventi del canale sono **alert per l'operatore**, e di che genere (DD §3.2; RASD R11, R12).
 *
 * Sta in un modulo suo e non dentro il componente perché è l'unica parte del pannello che può
 * *sbagliare* in silenzio: un filtro troppo stretto non produce un errore, produce un pannello che
 * sembra funzionare e non dice metà delle cose. Separata dal rendering si può provare con delle
 * notifiche costruite a mano, che è ciò che il test accanto fa.
 *
 * **Il riconoscimento passa dai campi strutturati, non da `type`.** Tutti gli eventi che
 * interessano a questo pannello arrivano con `type: null` (decisione D42): l'enum
 * `NotificationType` del RASD categorizza le notifiche *al passeggero*, e la politica con cui il
 * sistema sceglie i veicoli o i movimenti a vuoto della flotta sono affari dell'operatore.
 *
 * `REBALANCING_ALERT` in particolare **non viene mai emesso**, ed è una scelta scritta nel backend:
 * assegnarlo farebbe scrivere una `Notification` senza destinatario. Filtrare su quel valore era un
 * ramo morto, ed è il difetto che questa separazione ha reso verificabile — il riposizionamento,
 * cioè metà di ciò che il DD §3.2 chiede a questo pannello, non compariva mai.
 */

export const ALERT_CATEGORIES = ['high', 'medium', 'mode', 'rebalancing'] as const;
export type AlertCategory = (typeof ALERT_CATEGORIES)[number];

/**
 * La categoria dell'evento, o `null` se non è un alert per l'operatore.
 *
 * Una funzione sola invece di un predicato più un classificatore: erano due letture degli stessi
 * campi, e tenerle separate significava poterle far divergere — un evento riconosciuto come alert e
 * poi classificato con la categoria di un altro.
 */
/**
 * Accetta **entrambe le sorgenti**, e la firma allargata è la ragione per cui esiste una regola
 * sola: la riga che arriva dalla socket e quella riletta dallo storico portano gli stessi quattro
 * campi, e classificarle con due funzioni diverse significherebbe poterle far divergere — lo stesso
 * fatto colorato in due modi a seconda di quando lo si è guardato (decisione D77).
 */
export function alertCategoryOf(
  event: Pick<NotificationPush | OperatorAlert, 'zoneId' | 'trafficLevel' | 'mode' | 'strategy'>,
): AlertCategory | null {
  // Il riposizionamento si riconosce da `zoneId`, che `REBALANCING_STARTED` porta e nessun altro
  // evento di flotta ha. Viene per primo perché è il più specifico.
  if (event.zoneId !== null) return 'rebalancing';
  if (event.trafficLevel === 'HIGH') return 'high';
  if (event.trafficLevel === 'MEDIUM') return 'medium';
  // Ciò che resta e parla di modo o strategia è uno switch: automatico o manuale che sia, è una
  // decisione sul governo del sistema e l'operatore deve vederla.
  if (event.mode !== null || event.strategy !== null) return 'mode';
  return null;
}
