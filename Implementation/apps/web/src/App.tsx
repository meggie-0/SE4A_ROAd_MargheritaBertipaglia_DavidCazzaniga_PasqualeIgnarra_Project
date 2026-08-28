import {
  ApiError,
  FLEET_POSITION_REFRESH_MS,
  fetchHealth,
  type AuthResponse,
  type ModeResponse,
  type StrategyName,
} from '@road/shared';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { applyTheme, loadTheme, type Theme } from './theme';
import {
  completeMaintenance,
  enableAutoMode,
  fetchFleetStatus,
  fetchMode,
  setActiveStrategy,
  startMaintenance,
} from './api';
import { apiBaseUrl } from './api-base-url';
import { AlertsPanel } from './components/AlertsPanel';
import { FleetMap } from './components/FleetMap';
import { LoginScreen } from './components/LoginScreen';
import { ProfilePanel } from './components/ProfilePanel';
import { StatusBar } from './components/StatusBar';
import { StrategyPanel } from './components/StrategyPanel';
import { applyModeEvent } from './mode-events';
import { clearSession, loadSession, saveSession, type Session } from './session';
import { useNotifications } from './use-notifications';
import { MaintenancePanel } from './components/MaintenancePanel';
import { OperationalLog } from './components/OperationalLog';

/**
 * La dashboard dell'operatore di flotta (DD §3.2).
 *
 * È una console di comando e controllo, e la sua forma segue quella del documento: mappa della
 * flotta viva, pannello strategia con il toggle Auto/Manual sempre visibile, pannello alert per gli
 * switch automatici e i suggerimenti di riposizionamento, status bar con il riepilogo per stato.
 * Tutto su una schermata sola: NFR6 chiede che modo e strategia si vedano «on the dashboard's first
 * render, without navigating», e una dashboard con delle schede lo violerebbe per costruzione.
 *
 * **Tre nature, non due.** Le posizioni si rileggono a intervalli, perché cambiano a ogni tick e sul
 * canale push inonderebbero tutto: è la divisione che `FleetMonitorPort.recordPositions()` fissa nel
 * backend, vista dal lato di chi guarda. Modo, strategia e alert arrivano **push**, perché sono
 * eventi discreti e NFR2 pretende che raggiungano un client connesso senza che lo chieda.
 *
 * Il **livello di traffico** è il terzo caso, e fa entrambe le cose. Non ha un evento per ogni
 * osservazione, di proposito: R12 parla di *raggiungere* una soglia — non di uno stato — quindi
 * l'alert di `MEDIUM` si emette al passaggio e non a ogni lettura, e in modo Manual
 * `onTrafficLevel()` non notifica affatto (R13, NFR10). Un client che si limitasse ad ascoltare
 * resterebbe fermo all'ultimo evento per tutta la sessione, e dopo un `db:seed` mostrerebbe «Non
 * rilevato» a tempo indeterminato. Quindi lo si **rilegge** a intervalli, oltre a riceverlo dagli
 * eventi che lo portano: il push resta la via per i fatti discreti, la rilettura copre gli intervalli
 * in cui — correttamente — non succede niente (decisione D75).
 */

/**
 * Ogni quanto rileggere la fotografia della flotta.
 *
 * La cadenza è quella con cui il backend le posizioni le **produce** — mezzo secondo — e arriva da
 * `@road/shared` invece di essere scelta qui: il simulatore avanza e la telemetria scrive a quel
 * passo (`FleetTelemetrySchedule`), quindi rileggere più di rado mostrerebbe una flotta che scatta
 * da un punto all'altro, e più spesso ripeterebbe la stessa risposta. L'intervallo lo tiene
 * `@tanstack/react-query`: un `setInterval` scritto qui violerebbe la Regola 3, che vieta i timer
 * nel codice sorgente delle applicazioni.
 */
const FLEET_REFRESH_MS = FLEET_POSITION_REFRESH_MS;

/**
 * Ogni quanto rileggere modo, strategia e livello di traffico.
 *
 * **Quindici secondi è il limite superiore di quanto il badge può restare vecchio**, e il numero
 * viene da lì: il `TrafficMonitor` legge il traffico ogni cinque minuti, quindi rileggere più spesso
 * ripeterebbe la stessa risposta, e `GET /mode` è la lettura di una riga singleton indicizzata —
 * costa poco abbastanza da non doverla centellinare.
 *
 * La costante sta **qui e non in `packages/shared`**, a differenza di `FLEET_POSITION_REFRESH_MS`.
 * Quella ci sta perché il backend le posizioni le *produce* a quella cadenza e i due lati devono
 * coincidere; qui non c'è nessun accoppiamento del genere — è una scelta di quanto spesso questo
 * client vuole guardare, e appartiene al client che la fa.
 *
 * L'intervallo lo tiene `@tanstack/react-query`: un `setInterval` scritto qui violerebbe la Regola 3.
 */
const MODE_REFRESH_MS = 15_000;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

export function App(): React.JSX.Element {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}

function Dashboard(): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [commandError, setCommandError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showProfile, setShowProfile] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [showMenu, setShowMenu] = useState(false);
  const [selectedRobotaxiId, setSelectedRobotaxiId] = useState<string | null>(null);
  const [mapFocusTarget, setMapFocusTarget] = useState<{
    lat: number;
    lon: number;
    requestId: number;
  } | null>(null);
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const health = useApiHealth();
  const queries = useQueryClient();
  const token = session?.accessToken ?? null;
  const { notifications, connection } = useNotifications(token);

  /** L'ultimo evento già applicato a ciascuna vista, per non riapplicarlo a ogni render. */
  const lastModeEventRef = useRef<string | null>(null);
  const lastTrafficEventRef = useRef<string | null>(null);
  const lastFleetEventRef = useRef<string | null>(null);

  const fleet = useQuery({
    queryKey: ['fleet-status'],
    enabled: token !== null,
    refetchInterval: FLEET_REFRESH_MS,
    queryFn: () => fetchFleetStatus(token as string),
  });

  const selectedRobotaxi =
    fleet.data?.robotaxis.find((vehicle) => vehicle.id === selectedRobotaxiId) ?? null;

  function focusRobotaxiFromStatus(robotaxiId: string): void {
    const vehicle = fleet.data?.robotaxis.find((candidate) => candidate.id === robotaxiId);

    setSelectedRobotaxiId(robotaxiId);

    if (vehicle === undefined) {
      return;
    }

    setMapFocusTarget((current) => ({
      lat: vehicle.position.lat,
      lon: vehicle.position.lon,
      requestId: (current?.requestId ?? 0) + 1,
    }));
  }

  const mode = useQuery({
    queryKey: ['mode'],
    enabled: token !== null,
    refetchInterval: MODE_REFRESH_MS,
    queryFn: () => fetchMode(token as string),
  });

  useEffect(() => {
    setMaintenanceError(null);
  }, [selectedRobotaxiId]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  /**
   * Modo e strategia si aggiornano dal **canale push**, non ri-chiedendoli.
   *
   * È metà di ciò che NFR2 chiede alla dashboard: uno switch automatico deciso dal `ModeController`
   * deve comparire nel pannello senza che l'operatore ricarichi. La notifica porta i valori già
   * strutturati (M6), quindi non serve nemmeno rileggere — si scrive ciò che è appena successo
   * nella cache della query, e il pannello si ridipinge.
   *
   * La regola di fusione sta in `applyModeEvent()`, che è pura e provata a parte: qui resta solo la
   * scelta di *quale* evento applicare.
   */
  useEffect(() => {
    const last = [...notifications].reverse().find((event) => event.mode !== null);
    if (last === undefined) return;

    queries.setQueryData(['mode'], (previous: ModeResponse | undefined) => {
      const next = applyModeEvent(previous, last, lastModeEventRef.current);
      if (next !== previous) lastModeEventRef.current = last.occurredAt;
      return next;
    });
  }, [notifications, queries]);

  /**
   * Il **livello di traffico** segue gli eventi che lo portano, anche quando non portano un modo.
   *
   * Sta in un effetto suo, con un riferimento suo, e le due cose vanno insieme. `TRAFFIC_ALERT` ha
   * `mode` nullo — nasce dalla costante `NOTHING` di `notification-copy.ts` — quindi l'effetto qui
   * sopra lo scarta: senza questo, al passaggio `LOW → MEDIUM` il pannello alert annunciava la
   * soglia e il badge accanto continuava a dire «Basso».
   *
   * Il riferimento è separato perché i due tipi di evento arrivano intrecciati: condividendone uno,
   * un `MODE_CHANGED` appena applicato farebbe scartare come «vecchio» il `TRAFFIC_ALERT` che lo ha
   * preceduto di un istante, e viceversa. Sono due letture indipendenti della stessa coda.
   */
  useEffect(() => {
    const last = [...notifications].reverse().find((event) => event.trafficLevel !== null);
    if (last === undefined) return;

    queries.setQueryData(['mode'], (previous: ModeResponse | undefined) => {
      const next = applyModeEvent(previous, last, lastTrafficEventRef.current);
      if (next !== previous) lastTrafficEventRef.current = last.occurredAt;
      return next;
    });
  }, [notifications, queries]);

  /**
   * Una transizione di stato **ridipinge subito la mappa**, senza aspettare il giro successivo.
   *
   * È l'altra metà di NFR2, ed è quella che si dimentica: la §4.3 lo dichiara violato quando «the
   * client only learns of the change by issuing a new request», e senza questa riga un veicolo che
   * entra in manutenzione comparirebbe sulla dashboard fino a cinque secondi dopo — e solo perché
   * il client ha ri-chiesto. Le transizioni sul canale ci sono già; mancava chi le ascoltasse.
   *
   * Si **invalida** invece di scrivere in cache, ed è la differenza fra le due metà: la notifica di
   * modo porta il valore nuovo per intero, quella di flotta parla di un veicolo solo e la mappa ha
   * bisogno di tutti. Il costo è una richiesta per transizione, non per tick — che è precisamente
   * la ragione per cui le *posizioni* non viaggiano sul canale (decisione D67).
   */
  useEffect(() => {
    const last = [...notifications].reverse().find((event) => event.robotaxiState !== null);
    if (last === undefined) return;
    if (lastFleetEventRef.current === last.occurredAt) return;

    lastFleetEventRef.current = last.occurredAt;
    void queries.invalidateQueries({ queryKey: ['fleet-status'] });
  }, [notifications, queries]);

  function onAuthenticated(response: AuthResponse): void {
    const next: Session = { accessToken: response.accessToken, user: response.user };
    saveSession(next);
    setSession(next);
  }

  function signOut(): void {
    clearSession();
    setSession(null);
    setShowProfile(false);
    setShowMenu(false);
    queries.clear();
    setSelectedRobotaxiId(null);
  }

  /** Traduce un errore di comando, riportando al login se la sessione è finita. */
  function onCommandFailure(failure: unknown): void {
    if (failure instanceof ApiError && failure.status === 401) {
      signOut();
      return;
    }
    setCommandError(failure instanceof Error ? failure.message : String(failure));
  }

  function onMaintenanceFailure(failure: unknown): void {
    if (failure instanceof ApiError && failure.status === 401) {
      signOut();
      return;
    }

    setMaintenanceError(failure instanceof Error ? failure.message : String(failure));
  }
  /**
   * Una sessione scaduta riporta al login **anche quando a scoprirlo è una lettura**.
   *
   * Senza questo, un token scaduto si manifestava soltanto come «dati non aggiornati» sulla status
   * bar: l'operatore restava davanti a una mappa vuota, senza sapere che bastava rifare l'accesso,
   * e solo un comando — cioè un'azione che nessuno ha ragione di tentare davanti a una dashboard
   * che sembra rotta — lo avrebbe rimandato al login.
   */
  useEffect(() => {
    for (const failure of [fleet.error, mode.error]) {
      if (failure instanceof ApiError && failure.status === 401) {
        signOut();
        return;
      }
    }
    // Dipende dai due errori e non da `signOut`, che è ricreata a ogni render: ciò che deve far
    // ripartire l'effetto è il cambiare dell'esito delle letture, non l'identità della funzione.
  }, [fleet.error, mode.error]);

  async function chooseStrategy(strategy: StrategyName): Promise<void> {
    if (token === null) return;
    setBusy(true);
    setCommandError(null);
    try {
      await setActiveStrategy(token, strategy);
      // Si rilegge invece di scrivere in cache ciò che si è chiesto: la scelta manuale porta anche
      // in modo Manual, e la risposta della `PUT` porta la sola strategia. Chi decide cosa mostrare
      // è il backend, che è l'unica sede autorevole di entrambi i valori (NFR3).
      await queries.invalidateQueries({ queryKey: ['mode'] });
    } catch (failure) {
      onCommandFailure(failure);
    } finally {
      setBusy(false);
    }
  }

  async function backToAuto(): Promise<void> {
    if (token === null) return;
    setBusy(true);
    setCommandError(null);
    try {
      // `enableAuto()` rivaluta subito l'ultimo livello di traffico noto (decisione D11): la
      // strategia che ne esce può non essere quella scelta a mano, quindi si prende il risultato.
      const updated = await enableAutoMode(token);
      queries.setQueryData(['mode'], updated);
    } catch (failure) {
      onCommandFailure(failure);
    } finally {
      setBusy(false);
    }
  }

  async function beginSelectedMaintenance(reason: string): Promise<void> {
    if (token === null || selectedRobotaxi === null) return;

    setMaintenanceBusy(true);
    setMaintenanceError(null);

    try {
      await startMaintenance(token, selectedRobotaxi.id, reason);

      await queries.invalidateQueries({
        queryKey: ['fleet-status'],
      });
    } catch (failure) {
      onMaintenanceFailure(failure);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function completeSelectedMaintenance(): Promise<void> {
    if (token === null || selectedRobotaxi === null) return;

    setMaintenanceBusy(true);
    setMaintenanceError(null);

    try {
      await completeMaintenance(token, selectedRobotaxi.id);

      await queries.invalidateQueries({
        queryKey: ['fleet-status'],
      });
    } catch (failure) {
      onMaintenanceFailure(failure);
    } finally {
      setMaintenanceBusy(false);
    }
  }

  if (session === null) {
    return (
      <main className="dashboard dashboard--guest">
        <header className="operator-guest-header">
          <div className="operator-login-logo-frame">
            <img
              className="operator-login-logo"
              src={theme === 'dark' ? '/road-logo-dark.png' : '/road-logo-light.png'}
              alt="ROAd"
            />
          </div>

          <h1 className="visually-hidden">ROAd — Dashboard operatore</h1>
        </header>

        <LoginScreen onAuthenticated={onAuthenticated} />

        <ApiFooter health={health} />
      </main>
    );
  }

  return (
    <main className="dashboard">
      {/*
       * Il titolo della pagina, letto dagli assistenti vocali e non dagli occhi.
       *
       * Il logo lo dice già a chi guarda, ma un `alt` su un'immagine **non è un'intestazione**: chi
       * naviga saltando da un titolo all'altro — che è il modo in cui si esplora una schermata con
       * uno screen reader — su una pagina senza `h1` non trova da dove cominciare. La classe lo
       * toglie dal flusso visivo senza toglierlo dall'albero di accessibilità, che è la differenza
       * fra nasconderlo e cancellarlo (`display: none` farebbe la seconda).
       */}
      <h1 className="visually-hidden">ROAd — Dashboard operatore</h1>

      <div className="operator-toolbar">
        <StatusBar
          status={fleet.data ?? null}
          stale={fleet.isError}
          selectedRobotaxiId={selectedRobotaxiId}
          onFocusRobotaxi={focusRobotaxiFromStatus}
        />

        {/*
         * Lo stato del **canale push**, accanto al riepilogo della flotta e non dentro un menù.
         *
         * Distingue le due letture di una dashboard immobile: una flotta ferma e una socket caduta.
         * Sono la stessa immagine e due guasti opposti, e senza questo indicatore l'unico modo di
         * separarli è ricaricare la pagina — cioè fare a mano ciò che NFR2 promette non serva. È la
         * stessa ragione per cui il piede della schermata mostra l'esito di `GET /health`: quello
         * dice se il backend risponde, questo se ciò che il backend manda sta arrivando.
         *
         * Il colore non porta il significato da solo: la parola accanto lo dice, come per il badge
         * del traffico e per i marker di stato.
         */}
        <span
          className={connection === 'connected' ? 'push-status push-on' : 'push-status push-off'}
          data-testid="push-connection"
          data-connection={connection}
        >
          <span className="push-dot" aria-hidden="true" />
          {connection === 'connected' ? 'canale attivo' : 'canale non connesso'}
        </span>

        <button
          type="button"
          className="operator-menu-toggle"
          data-testid="open-menu"
          aria-label={showMenu ? 'Chiudi menu' : 'Apri menu'}
          aria-expanded={showMenu}
          aria-controls="operator-menu"
          onClick={() => setShowMenu((current) => !current)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </div>

      {showMenu && (
        <>
          <button
            type="button"
            className="operator-menu-backdrop"
            aria-label="Chiudi menu"
            onClick={() => setShowMenu(false)}
          />

          <aside id="operator-menu" className="operator-menu" aria-label="Menu operatore">
            <div className="operator-menu-heading">
              <h2>Il tuo account</h2>

              <button
                type="button"
                className="operator-menu-close"
                aria-label="Chiudi menu"
                onClick={() => setShowMenu(false)}
              >
                <svg
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                >
                  <path d="M6 6l12 12" />
                  <path d="M18 6 6 18" />
                </svg>
              </button>
            </div>

            <div className="operator-menu-profile">
              <div className="operator-menu-avatar" aria-hidden="true">
                {session.user.name.charAt(0)}
                {session.user.surname.charAt(0)}
              </div>

              <div>
                <strong data-testid="operator-name">
                  {session.user.name} {session.user.surname}
                </strong>
                <span>{session.user.email}</span>
              </div>
            </div>

            <div className="operator-menu-actions">
              <button
                type="button"
                className="operator-menu-action"
                data-testid="open-profile"
                onClick={() => {
                  setShowMenu(false);
                  setShowProfile(true);
                }}
              >
                Modifica profilo
              </button>
              <button
                type="button"
                className="operator-menu-action"
                data-testid="theme-toggle"
                data-theme={theme}
                onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
              >
                <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
                <span>{theme === 'dark' ? 'Attiva modalità giorno' : 'Attiva modalità notte'}</span>
              </button>
              <button
                type="button"
                className="operator-menu-action operator-menu-action--danger"
                data-testid="sign-out"
                onClick={signOut}
              >
                Esci
              </button>
            </div>
          </aside>
        </>
      )}
      <div className="dashboard-body">
        <div className="map-column">
          <FleetMap
            robotaxis={fleet.data?.robotaxis ?? []}
            selectedRobotaxiId={selectedRobotaxiId}
            onSelectRobotaxi={setSelectedRobotaxiId}
            onClearSelection={() => setSelectedRobotaxiId(null)}
            focusTarget={mapFocusTarget}
          />
          <OperationalLog notifications={notifications} onFocusRobotaxi={focusRobotaxiFromStatus} />
        </div>
        <div className="side-panels">
          {/* Il profilo prende il posto dei pannelli laterali, non della mappa né della status
              bar: la superficie di monitoraggio resta visibile (R7, NFR10). */}
          <StrategyPanel
            mode={mode.data?.mode ?? null}
            activeStrategy={mode.data?.activeStrategy ?? null}
            trafficLevel={mode.data?.trafficLevel ?? null}
            busy={busy}
            error={commandError}
            onSelectStrategy={(strategy) => void chooseStrategy(strategy)}
            onEnableAuto={() => void backToAuto()}
          />

          {showProfile ? (
            <ProfilePanel
              profile={session.user}
              token={session.accessToken}
              onUpdated={(profile) => {
                const next: Session = {
                  accessToken: session.accessToken,
                  user: profile,
                };

                saveSession(next);
                setSession(next);
              }}
              onClose={() => setShowProfile(false)}
              onSessionExpired={(failure) => {
                if (failure instanceof ApiError && failure.status === 401) {
                  signOut();
                }
              }}
            />
          ) : (
            <MaintenancePanel
              vehicle={selectedRobotaxi}
              busy={maintenanceBusy}
              error={maintenanceError}
              onStartMaintenance={(reason) => void beginSelectedMaintenance(reason)}
              onCompleteMaintenance={() => void completeSelectedMaintenance()}
            />
          )}

          <AlertsPanel notifications={notifications} />
        </div>
      </div>

      <ApiFooter health={health} />
    </main>
  );
}

function ApiFooter({ health }: { health: string }): React.JSX.Element {
  return (
    <footer className="app-footer">
      API <span data-testid="api-health-status">{health}</span> · {apiBaseUrl}
    </footer>
  );
}

/**
 * Lo stato del backend, letto da `GET /health` con la funzione di `@road/shared`.
 *
 * È il pezzo di M0 che **resta**: il suo cancello verifica che i due client mostrino lo stato letto
 * da quell'endpoint, e HARNESS.md §6 dice che un cancello già passato non torna mai rosso. Su una
 * console di monitoraggio è anche l'indicatore che distingue una flotta ferma da un backend spento,
 * che è la prima domanda di chi vede una mappa che non si muove.
 */
function useApiHealth(): string {
  const [status, setStatus] = useState('…');

  useEffect(() => {
    let cancelled = false;

    fetchHealth(apiBaseUrl)
      .then((probe) => {
        if (!cancelled) setStatus(probe.status);
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
