import {
  ApiError,
  fetchHealth,
  type AuthResponse,
  type ModeResponse,
  type StrategyName,
} from '@road/shared';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { enableAutoMode, fetchFleetStatus, fetchMode, setActiveStrategy } from './api';
import { apiBaseUrl } from './api-base-url';
import { AlertsPanel } from './components/AlertsPanel';
import { FleetMap } from './components/FleetMap';
import { LoginScreen } from './components/LoginScreen';
import { StatusBar } from './components/StatusBar';
import { StrategyPanel } from './components/StrategyPanel';
import { clearSession, loadSession, saveSession, type Session } from './session';
import { useNotifications } from './use-notifications';

/**
 * La dashboard dell'operatore di flotta (DD §3.2).
 *
 * È una console di comando e controllo, e la sua forma segue quella del documento: mappa della
 * flotta viva, pannello strategia con il toggle Auto/Manual sempre visibile, pannello alert per gli
 * switch automatici e i suggerimenti di riposizionamento, status bar con il riepilogo per stato.
 * Tutto su una schermata sola: NFR6 chiede che modo e strategia si vedano «on the dashboard's first
 * render, without navigating», e una dashboard con delle schede lo violerebbe per costruzione.
 *
 * **Due sorgenti, due nature.** Le posizioni si rileggono a intervalli, perché cambiano a ogni tick
 * e sul canale push inonderebbero tutto; modo, strategia e alert arrivano **push**, perché sono
 * eventi discreti e NFR2 pretende che raggiungano un client connesso senza che lo chieda. Non è un
 * compromesso: è la divisione che `FleetMonitorPort.recordPositions()` fissa nel backend, vista dal
 * lato di chi guarda.
 */

/**
 * Ogni quanto rileggere la fotografia della flotta.
 *
 * Cinque secondi: il simulatore avanza ogni dieci e la telemetria si legge ogni dieci
 * (`FleetTelemetrySchedule`), quindi con questo passo nessun movimento resta invisibile più di un
 * ciclo. L'intervallo lo tiene `@tanstack/react-query`: un `setInterval` scritto qui violerebbe la
 * Regola 3, che vieta i timer nel codice sorgente delle applicazioni.
 */
const FLEET_REFRESH_MS = 5_000;

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

  const health = useApiHealth();
  const queries = useQueryClient();
  const token = session?.accessToken ?? null;
  const { notifications, connection } = useNotifications(token);

  /** L'ultimo evento già applicato a ciascuno dei due pannelli, per non riapplicarlo a ogni render. */
  const lastModeEventRef = useRef<string | null>(null);
  const lastFleetEventRef = useRef<string | null>(null);

  const fleet = useQuery({
    queryKey: ['fleet-status'],
    enabled: token !== null,
    refetchInterval: FLEET_REFRESH_MS,
    queryFn: () => fetchFleetStatus(token as string),
  });

  const mode = useQuery({
    queryKey: ['mode'],
    enabled: token !== null,
    queryFn: () => fetchMode(token as string),
  });

  /**
   * Modo e strategia si aggiornano dal **canale push**, non ri-chiedendoli.
   *
   * È metà di ciò che NFR2 chiede alla dashboard: uno switch automatico deciso dal `ModeController`
   * deve comparire nel pannello senza che l'operatore ricarichi. La notifica porta i valori già
   * strutturati (M6), quindi non serve nemmeno rileggere — si scrive ciò che è appena successo
   * nella cache della query, e il pannello si ridipinge.
   *
   * **L'istante decide chi vince.** Fra una notifica e la risposta di una `PUT` può arrivare prima
   * l'una o l'altra, e senza un confronto un evento vecchio di un secondo sovrascriverebbe il
   * risultato di un comando appena eseguito. Si applica solo ciò che è più recente di quanto già
   * mostrato: `occurredAt` è l'istante del cambiamento, non quello della consegna.
   */
  useEffect(() => {
    const last = [...notifications].reverse().find((event) => event.mode !== null);
    if (last === undefined || last.mode === null) return;
    if (lastModeEventRef.current !== null && last.occurredAt <= lastModeEventRef.current) return;

    lastModeEventRef.current = last.occurredAt;
    queries.setQueryData(['mode'], (previous: ModeResponse | undefined) => ({
      mode: last.mode ?? previous?.mode ?? 'AUTO',
      activeStrategy: last.strategy ?? previous?.activeStrategy ?? 'NEAREST_AVAILABLE',
    }));
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
    queries.clear();
  }

  /** Traduce un errore di comando, riportando al login se la sessione è finita. */
  function onCommandFailure(failure: unknown): void {
    if (failure instanceof ApiError && failure.status === 401) {
      signOut();
      return;
    }
    setCommandError(failure instanceof Error ? failure.message : String(failure));
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

  if (session === null) {
    return (
      <main className="dashboard">
        <LoginScreen onAuthenticated={onAuthenticated} />
        <ApiFooter health={health} />
      </main>
    );
  }

  return (
    <main className="dashboard">
      <header className="app-header">
        <h1>ROAd — Dashboard operatore</h1>
        <div className="who">
          <span
            className={connection === 'connected' ? 'push-on' : 'push-off'}
            data-testid="push-connection"
            data-connection={connection}
          >
            {connection === 'connected' ? 'canale attivo' : 'canale non connesso'}
          </span>
          <span data-testid="operator-name">{session.user.name}</span>
          <button type="button" className="link-button" data-testid="sign-out" onClick={signOut}>
            Esci
          </button>
        </div>
      </header>

      <StatusBar status={fleet.data ?? null} stale={fleet.isError} />

      <div className="dashboard-body">
        <FleetMap robotaxis={fleet.data?.robotaxis ?? []} />

        <div className="side-panels">
          <StrategyPanel
            mode={mode.data?.mode ?? null}
            activeStrategy={mode.data?.activeStrategy ?? null}
            busy={busy}
            error={commandError}
            onSelectStrategy={(strategy) => void chooseStrategy(strategy)}
            onEnableAuto={() => void backToAuto()}
          />
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
