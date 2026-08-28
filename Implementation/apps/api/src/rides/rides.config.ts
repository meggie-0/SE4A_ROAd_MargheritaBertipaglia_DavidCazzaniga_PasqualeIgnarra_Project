import type { ConfigService } from '@nestjs/config';

import {
  DEFAULT_RESERVATION_TIMING,
  type ReservationTiming,
} from '../persistence/persistence.port';

/**
 * I tempi con cui `rides` riserva i veicoli, letti dall'ambiente (decisione D76).
 *
 * Vive in un file suo per la stessa ragione di `external.config.ts`: i valori li leggono due
 * componenti — `RideRequestManager` quando accetta una prenotazione e `AdvanceBookingActivator`
 * quando la trasforma in assegnazione — e due letture indipendenti dello stesso nome divergono al
 * primo refuso.
 *
 * **Era lavoro già previsto dal codice.** Il commento di `DEFAULT_RESERVATION_TIMING` lo annunciava:
 * «quando M4 avrà bisogno di renderli configurabili, `RideRequestManager` li leggerà da
 * `ConfigService` e passerà un `ReservationTiming` esplicito alle funzioni qui sotto, **che lo
 * accettano già**». Le firme non cambiano; cambia chi passa il parametro.
 *
 * **Solo l'anticipo è configurabile, non il buffer.** L'anticipo è ciò che una dimostrazione deve
 * accorciare — quindici minuti di attesa non si mostrano a nessuno — mentre il buffer protegge il
 * vincolo di non sovrapposizione delle riserve: accorciarlo non renderebbe la demo più breve e
 * avvicinerebbe due riserve consecutive sullo stesso veicolo, che è precisamente ciò che la D8
 * evita. Un valore configurabile in più senza una ragione è una manopola che qualcuno girerà.
 */
export function readReservationTiming(config: ConfigService): ReservationTiming {
  const raw = config.get<string>('RESERVATION_ACTIVATION_LEAD_MINUTES');
  const parsed = Number.parseInt((raw ?? '').trim(), 10);

  return {
    ...DEFAULT_RESERVATION_TIMING,
    // Un valore assente, non numerico o negativo ricade sul default invece di produrre un anticipo
    // senza senso: `NaN` propagato in `activationDueAt()` darebbe una data invalida, e una
    // prenotazione con `activationDueAt` invalido non verrebbe mai trovata dalla query.
    activationLeadMinutes:
      Number.isFinite(parsed) && parsed >= 0
        ? parsed
        : DEFAULT_RESERVATION_TIMING.activationLeadMinutes,
  };
}
