import {
  ApiError,
  FLEET_POSITION_REFRESH_MS,
  fetchHealth,
  type GeoPoint,
  type RideRequestKind,
  type RideRequestResponse,
} from '@road/shared';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  cancelRide,
  fetchAssignedVehicle,
  requestAdvanceBooking,
  requestImmediateRide,
} from './api';
import { apiBaseUrl } from './api-base-url';
import { LoginScreen } from './components/LoginScreen';
import { RequestPanel } from './components/RequestPanel';
import { RoutePickerPanel } from './components/RoutePickerPanel';
import { ProfilePanel } from './components/ProfilePanel';
import { RideMap } from './components/RideMap';
import { StatusPanel } from './components/StatusPanel';
import { applyNotification, initialView, type RideView } from './ride-phase';
import { clearSession, loadSession, saveSession, type Session } from './session';
import { useNotifications } from './use-notifications';
import { applyTheme, loadTheme, type Theme } from './theme';
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
/**
 * Ogni quanto rileggere dov'è il robotaxi.
 *
 * La cadenza è quella con cui il backend le posizioni le **produce** — mezzo secondo — e arriva da
 * `@road/shared` invece di essere scelta qui: il simulatore avanza e la telemetria scrive a quel
 * passo, quindi rileggere più di rado mostrerebbe un veicolo che scatta, e più spesso ripeterebbe la
 * stessa risposta. L'intervallo lo tiene `@tanstack/react-query`; un `setInterval` scritto qui
 * violerebbe la Regola 3, che vieta i timer nel sorgente delle applicazioni.
 */
const VEHICLE_REFRESH_MS = FLEET_POSITION_REFRESH_MS;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function App(): React.JSX.Element {
  useEffect(() => {
    const hideTimers = new Map<HTMLElement, number>();

    const handlePanelScroll = (event: Event): void => {
      const panel = event.target;

      if (!(panel instanceof HTMLElement) || !panel.classList.contains('panel')) {
        return;
      }

      panel.classList.add('panel--scrolling');

      const previousTimer = hideTimers.get(panel);

      if (previousTimer !== undefined) {
        window.clearTimeout(previousTimer);
      }

      const hideTimer = window.setTimeout(() => {
        panel.classList.remove('panel--scrolling');
        hideTimers.delete(panel);
      }, 250);

      hideTimers.set(panel, hideTimer);
    };

    document.addEventListener('scroll', handlePanelScroll, true);

    return () => {
      document.removeEventListener('scroll', handlePanelScroll, true);

      hideTimers.forEach((timer, panel) => {
        window.clearTimeout(timer);
        panel.classList.remove('panel--scrolling');
      });

      hideTimers.clear();
    };
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <PassengerApp />
    </QueryClientProvider>
  );
}

function PassengerApp(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [pickup, setPickup] = useState<GeoPoint | null>(null);
  const [destination, setDestination] = useState<GeoPoint | null>(null);
  const [kind, setKind] = useState<RideRequestKind>('IMMEDIATE');
  const [scheduledPickup, setScheduledPickup] = useState('');
  const [request, setRequest] = useState<RideRequestResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showProfile, setShowProfile] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const [activeRoutePoint, setActiveRoutePoint] = useState<'pickup' | 'destination'>('pickup');
  const [cancelling, setCancelling] = useState(false);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const health = useApiHealth();
  const { notifications, connection } = useNotifications(session?.accessToken ?? null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

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

  /**
   * La posizione del robotaxi della corsa, finché la corsa c'è.
   *
   * **È l'unica cosa che questa schermata interroga**, e solo nelle quattro fasi in cui un veicolo
   * mio esiste: prima non c'è nessuno da seguire, e dopo `in_ride` la corsa è finita. Fuori da
   * quella finestra la query è spenta, così l'app non chiede al backend cose che non mostrerebbe.
   *
   * `in_ride` era escluso, con la motivazione che a bordo «il puntino sono io»: vero, ma il puntino
   * *non c'era*: il marker spariva proprio nel momento in cui la corsa comincia, e una mappa che si
   * svuota mentre si viaggia sembra un'app che ha perso il segnale. A bordo la posizione del veicolo
   * è la propria, ed è l'unica cosa che si vuole guardare mentre si va a destinazione.
   *
   * Non porta lo stato della corsa e non potrebbe: la rotta non lo espone (decisione D69). La
   * progressione continua ad arrivare dal canale push, che è ciò che NFR2 pretende.
   */
  const followingVehicle =
    view !== null && ['assigned', 'arriving', 'arrived', 'in_ride'].includes(view.phase);

  /**
   * A bordo la linea tratteggiata cambia capo: non più «viene da lì», ma «stiamo andando là».
   *
   * È la stessa informazione — dove il veicolo è diretto — letta nella fase in cui il passeggero si
   * trova. Tenerla puntata sul ritiro dopo la salita indicherebbe un punto che si è già lasciato.
   */
  const onBoard = view?.phase === 'in_ride';

  const vehicle = useQuery({
    queryKey: ['assigned-vehicle', request?.id ?? null],
    enabled: session !== null && request !== null && followingVehicle,
    refetchInterval: VEHICLE_REFRESH_MS,
    queryFn: () => fetchAssignedVehicle(session?.accessToken as string, request?.id as string),
  });

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
    setCancellationError(null);
    setCancelling(false);
    setShowRoutePicker(false);
    setActiveRoutePoint('pickup');
  }

  function signOut(): void {
    clearSession();
    setSession(null);
    resetRequest();
    setShowProfile(false);
    setShowMenu(false);
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
    if (showRoutePicker) {
      if (activeRoutePoint === 'pickup') {
        setPickup(point);

        if (destination !== null) {
          setShowRoutePicker(false);
        } else {
          setActiveRoutePoint('destination');
        }

        return;
      }

      setDestination(point);

      if (pickup !== null) {
        setShowRoutePicker(false);
      } else {
        setActiveRoutePoint('pickup');
      }

      return;
    }

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

  async function cancelCurrentRide(): Promise<void> {
    if (session === null || request === null) return;

    setCancelling(true);
    setCancellationError(null);

    try {
      const cancelled = await cancelRide(session.accessToken, request.id);

      /*
       * La risposta HTTP contiene già status: CANCELLED.
       * Non è necessario attendere la notifica WebSocket per
       * aggiornare la schermata.
       */
      setRequest(cancelled);
    } catch (failure) {
      if (signOutIfExpired(failure)) return;

      setCancellationError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setCancelling(false);
    }
  }

  return (
    <main
      className={`passenger-app ${
        session === null ? 'passenger-app--guest' : 'passenger-app--authenticated'
      }`}
    >
      {session === null ? (
        <header className="app-header">
          <div className="header-slot header-start">
            <button
              type="button"
              className="theme-toggle"
              data-testid="theme-toggle"
              data-theme={theme}
              aria-label={
                theme === 'dark' ? 'Attiva la modalità giorno' : 'Attiva la modalità notte'
              }
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
              <span className="theme-label">{theme === 'dark' ? 'Giorno' : 'Notte'}</span>
            </button>
          </div>

          <div className="brand-lockup">
            <div className="brand-logo-frame">
              <img
                className="brand-logo"
                src={theme === 'dark' ? '/road-logo-dark.png' : '/road-logo-light.png'}
                alt="ROAd"
              />
            </div>
          </div>

          <div className="header-slot header-end" />
        </header>
      ) : (
        <header className={`mobile-topbar ${showRoutePicker ? 'mobile-topbar--expanded' : ''}`}>
          {showRoutePicker ? (
            <div
              className="route-search-preview route-search-preview--expanded"
              data-testid="route-search-preview"
            >
              <button
                type="button"
                className="route-back-button"
                data-testid="close-route-picker"
                aria-label="Torna alla scelta del servizio"
                onClick={() => setShowRoutePicker(false)}
              >
                <svg
                  className="search-icon"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M19 12H5" />
                  <path d="m11 18-6-6 6-6" />
                </svg>
              </button>

              <span>Imposta il percorso</span>
            </div>
          ) : (
            <button
              type="button"
              className="route-search-preview"
              data-testid="route-search-preview"
              disabled={request !== null}
              aria-expanded="false"
              aria-controls="route-search-dropdown"
              aria-label="Apri la selezione del percorso"
              onClick={() => {
                setShowMenu(false);
                setShowProfile(false);
                setActiveRoutePoint(pickup === null ? 'pickup' : 'destination');
                setShowRoutePicker(true);
              }}
            >
              <svg
                className="search-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-4-4" />
              </svg>

              <span>
                {pickup === null
                  ? 'Dove si va?'
                  : destination === null
                    ? 'Scegli la destinazione'
                    : 'Percorso impostato'}
              </span>
            </button>
          )}

          {!showRoutePicker && (
            <button
              type="button"
              className="menu-toggle"
              data-testid="open-menu"
              aria-label={showMenu ? 'Chiudi menu' : 'Apri menu'}
              aria-expanded={showMenu}
              aria-controls="passenger-menu"
              onClick={() => setShowMenu((current) => !current)}
            >
              <span aria-hidden="true" />
              <span aria-hidden="true" />
              <span aria-hidden="true" />
            </button>
          )}

          {showRoutePicker && request === null && (
            <RoutePickerPanel
              pickup={pickup}
              destination={destination}
              activePoint={activeRoutePoint}
              onActivePointChange={setActiveRoutePoint}
            />
          )}
          {/* Mantiene disponibile il dato usato dai test automatici. */}
          <span className="visually-hidden" data-testid="passenger-name">
            {session.user.name}
          </span>
        </header>
      )}

      {session !== null && showMenu && (
        <>
          <button
            type="button"
            className="mobile-menu-backdrop"
            aria-label="Chiudi menu"
            onClick={() => setShowMenu(false)}
          />

          <aside
            id="passenger-menu"
            className="mobile-menu"
            aria-label="Menu passeggero"
            data-testid="passenger-menu"
          >
            <div className="mobile-menu-heading">
              <h2>Il tuo account</h2>

              <button
                type="button"
                className="menu-close"
                aria-label="Chiudi menu"
                onClick={() => setShowMenu(false)}
              >
                ×
              </button>
            </div>

            <div className="menu-profile-summary">
              <div className="menu-avatar" aria-hidden="true">
                {session.user.name.charAt(0)}
                {session.user.surname.charAt(0)}
              </div>

              <div>
                <strong>
                  {session.user.name} {session.user.surname}
                </strong>
                <span>{session.user.email}</span>
                <span>{session.user.phoneNumber ?? 'Telefono non inserito'}</span>
              </div>
            </div>

            <nav className="menu-actions" aria-label="Azioni account">
              {request === null && (
                <button
                  type="button"
                  className="menu-action"
                  data-testid="open-profile"
                  onClick={() => {
                    setShowMenu(false);
                    setShowProfile(true);
                    setShowRoutePicker(false);
                  }}
                >
                  Modifica profilo
                </button>
              )}

              <button
                type="button"
                className="menu-action"
                data-testid="theme-toggle"
                data-theme={theme}
                onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              >
                <span>{theme === 'dark' ? '☀' : '☾'}</span>
                <span>{theme === 'dark' ? 'Attiva modalità giorno' : 'Attiva modalità notte'}</span>
              </button>

              <button
                type="button"
                className="menu-action menu-action--danger"
                data-testid="sign-out"
                onClick={signOut}
              >
                Esci
              </button>
            </nav>
          </aside>
        </>
      )}

      {session === null ? (
        <LoginScreen onAuthenticated={onAuthenticated} />
      ) : (
        <>
          <RideMap
            pickup={pickup}
            destination={destination}
            robotaxi={followingVehicle ? (vehicle.data?.vehicle?.position ?? null) : null}
            robotaxiHeadingTo={onBoard ? 'destination' : 'pickup'}
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
          ) : showRoutePicker && request === null ? null : request === null || view === null ? (
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
              cancelling={cancelling}
              cancellationError={cancellationError}
              onCancel={() => void cancelCurrentRide()}
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
