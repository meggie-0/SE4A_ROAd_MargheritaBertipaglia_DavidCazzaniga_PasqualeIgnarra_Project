import {
  ApiError,
  fetchHealth,
  type GeoPoint,
  type RideRequestKind,
  type RideRequestResponse,
} from '@road/shared';
import { useEffect, useMemo, useState } from 'react';

import { requestAdvanceBooking, requestImmediateRide } from './api';
import { apiBaseUrl } from './api-base-url';
import { LoginScreen } from './components/LoginScreen';
import { RequestPanel } from './components/RequestPanel';
import { ProfilePanel } from './components/ProfilePanel';
import { RideMap } from './components/RideMap';
import { StatusPanel } from './components/StatusPanel';
import { applyNotification, initialView, type RideView } from './ride-phase';
import { clearSession, loadSession, saveSession, type Session } from './session';
import { useNotifications } from './use-notifications';

/**
 * L'app del passeggero (DD §3.1), consegnata come PWA responsive (decisione D15).
 *
 * Una schermata sola, centrata sulla mappa, in due momenti: **comporre** la richiesta e
 * **seguirla**. Il secondo prende il posto del primo sullo stesso schermo, come il DD prescrive —
 * non c'è navigazione, non ci sono rotte, e non serve `react-router` perché non c'è niente da
 * instradare.
 *
 * **Il confine.** Questo client non importa una riga dal backend: lo conosce attraverso
 * `contracts/openapi.json`, i tipi di `@road/shared` e nient'altro (CLAUDE.md Regola 1). È anche ciò
 * che rende vera la promessa di NFR8 dal lato del frontend — riscriverlo in un altro framework non
 * tocca il server.
 *
 * (Il percorso del backend non compare nemmeno scritto in un commento: il cancello di M0 verifica
 * l'assenza di quella stringa in questo file, e un commento che la nominasse lo farebbe fallire
 * dicendo il falso.)
 */
export function App(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [pickup, setPickup] = useState<GeoPoint | null>(null);
  const [destination, setDestination] = useState<GeoPoint | null>(null);
  const [kind, setKind] = useState<RideRequestKind>('IMMEDIATE');
  const [scheduledPickup, setScheduledPickup] = useState('');
  const [request, setRequest] = useState<RideRequestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);

  const health = useApiHealth();
  const { notifications, connection } = useNotifications(session?.accessToken ?? null);

  /**
   * La vista di stato è **derivata**, non accumulata: si ricalcola ogni volta riducendo tutte le
   * notifiche di questa corsa a partire dallo stato in cui la richiesta è tornata.
   *
   * La prima versione teneva un cursore sull'elenco — «quante ne ho già applicate» — e aveva due
   * difetti, entrambi silenziosi. L'elenco è a lunghezza fissa e scarta le più vecchie: appena
   * saturava, la sua lunghezza smetteva di crescere e il cursore non avanzava più, quindi **la
   * schermata si congelava mentre la corsa proseguiva**. E ogni evento arrivato fra il ritorno
   * della richiesta e la comparsa della vista veniva contato come già applicato, cioè perso: con un
   * veicolo vicino, la transizione ad `ARRIVING` che porta l'ETA sta proprio in quella finestra.
   *
   * Ridurre da capo non ha nessuno dei due problemi, ed è possibile perché `applyNotification` è
   * una funzione pura di due valori: riapplicare la stessa notifica dà lo stesso risultato.
   *
   * Il filtro per `rideRequestId` non è una regola di dominio spostata sul client — il backend
   * consegna a un passeggero solo le proprie corse (DD §2.3.3) — ma la separazione fra la corsa che
   * sto guardando e le altre mie.
   */
  const view: RideView | null = useMemo(() => {
    if (request === null) return null;

    return notifications
      .filter((event) => event.rideRequestId === request.id)
      .reduce(applyNotification, initialView(request));
  }, [notifications, request]);

  function onAuthenticated(response: { accessToken: string; user: Session['user'] }): void {
    const next: Session = { accessToken: response.accessToken, user: response.user };
    saveSession(next);
    setSession(next);
  }

  function resetRequest(): void {
    setRequest(null);
    setPickup(null);
    setDestination(null);
    setError(null);
  }

  function signOut(): void {
    clearSession();
    setSession(null);
    resetRequest();
    setShowProfile(false);
  }

  /**
   * Un token scaduto non è un errore da mostrare in un riquadro rosso: è la fine della sessione, e
   * la risposta giusta è tornare al login invece di lasciare l'utente davanti a un pulsante che non
   * funzionerà più. Vale per la richiesta di una corsa come per il salvataggio del profilo.
   */
  function signOutIfExpired(failure: unknown): boolean {
    if (failure instanceof ApiError && failure.status === 401) {
      signOut();
      return true;
    }
    return false;
  }

  /** Il tocco sulla mappa riempie il primo posto libero: prima il ritiro, poi la destinazione. */
  function onPick(point: GeoPoint): void {
    if (pickup === null) {
      setPickup(point);
      return;
    }
    setDestination(point);
  }

  async function submit(): Promise<void> {
    if (session === null || pickup === null || destination === null) return;

    setBusy(true);
    setError(null);
    try {
      const submitted =
        kind === 'IMMEDIATE'
          ? await requestImmediateRide(session.accessToken, { pickup, destination })
          : await requestAdvanceBooking(session.accessToken, {
              pickup,
              destination,
              // `datetime-local` produce un orario locale senza fuso; il contratto ne vuole uno con
              // fuso, e la conversione la fa il browser, che il fuso dell'utente lo conosce.
              scheduledPickup: new Date(scheduledPickup).toISOString(),
            });

      setRequest(submitted);
    } catch (failure) {
      if (signOutIfExpired(failure)) return;
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="passenger-app">
      {session === null ? (
        <LoginScreen onAuthenticated={onAuthenticated} />
      ) : (
        <>
          <header className="app-header">
            <h1>ROAd — App passeggero</h1>
            <div className="who">
              <span data-testid="passenger-name">{session.user.name}</span>
              {/* Il profilo è raggiungibile solo quando non c'è una corsa da seguire: durante la
                  corsa lo schermo è la vista di stato, come il DD §3.1 prescrive. */}
              {request === null && (
                <button
                  type="button"
                  className="link-button"
                  data-testid="open-profile"
                  onClick={() => setShowProfile(!showProfile)}
                >
                  {showProfile ? 'Chiudi profilo' : 'Profilo'}
                </button>
              )}
              <button
                type="button"
                className="link-button"
                data-testid="sign-out"
                onClick={signOut}
              >
                Esci
              </button>
            </div>
          </header>

          <RideMap
            pickup={pickup}
            destination={destination}
            onPick={request === null ? onPick : null}
          />

          {showProfile && request === null ? (
            <ProfilePanel
              profile={session.user}
              token={session.accessToken}
              onUpdated={(profile) => {
                // Il profilo aggiornato si riscrive nella sessione: il token resta quello, ma il
                // nome mostrato nell'intestazione è quello nuovo.
                const next: Session = { accessToken: session.accessToken, user: profile };
                saveSession(next);
                setSession(next);
              }}
              onClose={() => setShowProfile(false)}
              onSessionExpired={signOutIfExpired}
            />
          ) : request === null || view === null ? (
            <RequestPanel
              pickup={pickup}
              destination={destination}
              kind={kind}
              scheduledPickup={scheduledPickup}
              busy={busy}
              error={error}
              onKindChange={setKind}
              onScheduledPickupChange={setScheduledPickup}
              onReset={() => {
                setPickup(null);
                setDestination(null);
              }}
              onSubmit={() => void submit()}
            />
          ) : (
            <StatusPanel
              request={request}
              view={view}
              connected={connection === 'connected'}
              onNewRequest={resetRequest}
            />
          )}
        </>
      )}

      <footer className="app-footer">
        API <span data-testid="api-health-status">{health}</span> · {apiBaseUrl}
      </footer>
    </main>
  );
}

/**
 * Lo stato del backend, letto da `GET /health` con la funzione di `@road/shared`.
 *
 * È il pezzo di M0 che **resta**: il suo cancello verifica che i due client mostrino lo stato letto
 * da quell'endpoint, e HARNESS.md §6 dice che un cancello già passato non torna mai rosso. Non è un
 * residuo tenuto per far contento un test — è l'indicatore che dice a chi guarda se l'assenza di
 * aggiornamenti è una flotta ferma o un backend spento, e distinguere le due cose è la prima
 * domanda di chiunque apra un'app che non si muove.
 */
function useApiHealth(): string {
  const [status, setStatus] = useState('…');

  useEffect(() => {
    let cancelled = false;

    fetchHealth(apiBaseUrl)
      .then((health) => {
        if (!cancelled) setStatus(health.status);
      })
      .catch(() => {
        if (!cancelled) setStatus('non raggiungibile');
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
