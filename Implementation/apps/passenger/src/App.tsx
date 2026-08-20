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
  fetchPassengerBookings,
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
import { reverseGeocodeMilanPoint, snapToNearestDrivableRoad } from './address-search';
import {
  isInsideLinateAirportArea,
  isInsideMilanServiceArea,
  isLinateAirportAddress,
  LINATE_TERMINAL_POINT,
} from './service-area';
import { BookingConfirmationPanel } from './components/BookingConfirmationPanel';
import { BookingsPanel } from './components/BookingsPanel';

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
  const [pickupAddress, setPickupAddress] = useState<string | null>(null);
  const [destinationAddress, setDestinationAddress] = useState<string | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [kind, setKind] = useState<RideRequestKind | null>(null);
  const [scheduledPickup, setScheduledPickup] = useState('');
  const [request, setRequest] = useState<RideRequestResponse | null>(null);
  const [bookingConfirmation, setBookingConfirmation] = useState<RideRequestResponse | null>(null);
  const [showBookings, setShowBookings] = useState(false);
  const [cancellingBookingId, setCancellingBookingId] = useState<string | null>(null);
  const [bookingsError, setBookingsError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [routePointErrors, setRoutePointErrors] = useState<{
    readonly pickup: string | null;
    readonly destination: string | null;
  }>({
    pickup: null,
    destination: null,
  });
  const [routePointWarnings, setRoutePointWarnings] = useState<{
    readonly pickup: string | null;
    readonly destination: string | null;
  }>({
    pickup: null,
    destination: null,
  });
  const [showProfile, setShowProfile] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showRoutePicker, setShowRoutePicker] = useState(false);
  const [activeRoutePoint, setActiveRoutePoint] = useState<'pickup' | 'destination' | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [cancellationError, setCancellationError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [mapResetKey, setMapResetKey] = useState(0);
  const health = useApiHealth();
  const { notifications, connection } = useNotifications(session?.accessToken ?? null);
  const passengerBookings = useQuery({
    queryKey: ['passenger-bookings', session?.user.id ?? null],
    enabled: session !== null,
    queryFn: () => {
      if (session === null) {
        throw new Error('Sessione non disponibile.');
      }

      return fetchPassengerBookings(session.accessToken);
    },
  });

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    const currentBookings = passengerBookings.data?.bookings;

    if (request !== null || currentBookings === undefined) {
      return;
    }

    /*
     * La notifica ASSIGNED indica che una prenotazione è stata realmente
     * attivata e che il robotaxi è stato assegnato.
     */
    const activation = [...notifications]
      .reverse()
      .find(
        (event) =>
          event.rideRequestId !== null &&
          event.robotaxiId !== null &&
          event.robotaxiState === 'ASSIGNED' &&
          currentBookings.some((booking) => booking.id === event.rideRequestId),
      );

    if (
      activation === undefined ||
      activation.rideRequestId === null ||
      activation.robotaxiId === null
    ) {
      return;
    }

    const activatedBooking = currentBookings.find(
      (booking) => booking.id === activation.rideRequestId,
    );

    if (activatedBooking === undefined) {
      return;
    }

    /*
     * Da questo momento non è più una prenotazione in attesa:
     * diventa la corsa live seguita da StatusPanel.
     */
    setRequest({
      ...activatedBooking,
      assignedRobotaxiId: activation.robotaxiId,
    });
    setPickup(activatedBooking.pickup);
    setPickupAddress(activatedBooking.pickupAddress);
    setDestination(activatedBooking.destination);
    setDestinationAddress(activatedBooking.destinationAddress);
    setBookingConfirmation(null);
    setShowBookings(false);
    setShowProfile(false);
    setShowRoutePicker(false);
    setShowMenu(false);

    if (session !== null) {
      void queryClient.invalidateQueries({
        queryKey: ['passenger-bookings', session.user.id],
      });
    }
  }, [notifications, passengerBookings.data, request, session]);

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
  const rideCompleted = view?.phase === 'completed';
  const hidePickupOnMap = onBoard || rideCompleted;

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
    setRoutePointWarnings({
      pickup: null,
      destination: null,
    });
    setPickupAddress(null);
    setDestinationAddress(null);
    setRoutePointErrors({
      pickup: null,
      destination: null,
    });
    setBookingConfirmation(null);
    setShowBookings(false);
    setBookingsError(null);
    setCancellingBookingId(null);
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

  function updateRoutePointError(
    pointType: 'pickup' | 'destination',
    message: string | null,
  ): void {
    setRoutePointErrors((current) => ({
      ...current,
      [pointType]: message,
    }));
  }

  function updateRoutePointWarning(
    pointType: 'pickup' | 'destination',
    message: string | null,
  ): void {
    setRoutePointWarnings((current) => ({
      ...current,
      [pointType]: message,
    }));
  }

  function activateRoutePoint(pointType: 'pickup' | 'destination'): void {
    updateRoutePointError(pointType, null);
    setActiveRoutePoint(pointType);
    updateRoutePointWarning(pointType, null);
  }

  function selectRoutePoint(
    pointType: 'pickup' | 'destination',
    point: GeoPoint,
    address: string | null,
  ): void {
    setError(null);
    updateRoutePointError(pointType, null);
    updateRoutePointWarning(pointType, null);
    setScheduledPickup('');

    if (pointType === 'pickup') {
      setPickup(point);
      setPickupAddress(address);

      // Dopo la partenza passa automaticamente alla destinazione.
      setKind(null);
      setActiveRoutePoint('destination');
      return;
    }

    setDestination(point);
    setDestinationAddress(address);

    // La corsa immediata è il servizio predefinito.
    setKind('IMMEDIATE');

    // Entrambi i punti sono presenti: mostra la scelta del servizio.
    setActiveRoutePoint(null);
  }

  function returnToInitialView(): void {
    setShowRoutePicker(false);
    setActiveRoutePoint(null);

    setPickup(null);
    setDestination(null);
    setPickupAddress(null);
    setDestinationAddress(null);

    setKind(null);
    setScheduledPickup('');
    setError(null);
    setRoutePointWarnings({
      pickup: null,
      destination: null,
    });

    setMapResetKey((current) => current + 1);
    setRoutePointErrors({
      pickup: null,
      destination: null,
    });
  }

  function clearRoutePoint(pointType: 'pickup' | 'destination'): void {
    setError(null);
    updateRoutePointError(pointType, null);
    setKind(null);
    setScheduledPickup('');
    setActiveRoutePoint(pointType);

    if (pointType === 'pickup') {
      setPickup(null);
      setPickupAddress(null);
      return;
    }

    setDestination(null);
    setDestinationAddress(null);
    updateRoutePointWarning(pointType, null);
  }

  async function selectRoutePointFromMap(point: GeoPoint): Promise<void> {
    if (activeRoutePoint === null) {
      return;
    }

    const pointType = activeRoutePoint;

    setError(null);
    updateRoutePointError(pointType, null);
    updateRoutePointWarning(pointType, null);

    let snappedPoint;

    try {
      snappedPoint = await snapToNearestDrivableRoad(point);
    } catch {
      updateRoutePointError(
        pointType,
        'Non è stato possibile verificare una strada raggiungibile. Riprova tra poco.',
      );
      return;
    }

    if (snappedPoint === null) {
      updateRoutePointError(
        pointType,
        'Il punto selezionato è troppo lontano da una strada raggiungibile. Scegli un altro punto.',
      );
      return;
    }

    const insideLinateAirport = isInsideLinateAirportArea(snappedPoint.point);

    if (!isInsideMilanServiceArea(snappedPoint.point) && !insideLinateAirport) {
      updateRoutePointError(
        pointType,
        'Il punto selezionato non si trova nell’area coperta dal servizio: Comune di Milano e Aeroporto di Linate.',
      );
      return;
    }

    let result;

    try {
      result = await reverseGeocodeMilanPoint(snappedPoint.point);
    } catch {
      updateRoutePointError(
        pointType,
        'Non è stato possibile verificare se il punto si trova nel Comune di Milano. Riprova tra poco.',
      );
      return;
    }

    const linateAirport = insideLinateAirport || isLinateAirportAddress(result.address);

    if (result.municipality === 'outside' && !linateAirport) {
      updateRoutePointError(
        pointType,
        'Il punto selezionato non si trova nel Comune di Milano o nell’area dell’aeroporto di Linate.',
      );
      return;
    }

    if (result.municipality === 'unknown' && !linateAirport) {
      updateRoutePointError(
        pointType,
        'Non è stato possibile verificare l’area del punto selezionato. Scegli un altro punto.',
      );
      return;
    }

    const selectedPoint = linateAirport ? LINATE_TERMINAL_POINT : snappedPoint.point;

    const selectedAddress = linateAirport
      ? (result.address ?? 'Aeroporto di Milano Linate')
      : result.address;

    selectRoutePoint(pointType, selectedPoint, selectedAddress);

    if (selectedAddress === null) {
      updateRoutePointWarning(
        pointType,
        'Punto valido: non è stato trovato un indirizzo leggibile, quindi vengono mostrate le coordinate.',
      );
    }
  }

  async function useCurrentLocation(): Promise<void> {
    if (!('geolocation' in navigator)) {
      updateRoutePointError(
        'pickup',
        'La geolocalizzazione non è supportata da questo dispositivo.',
      );
      return;
    }

    setIsLocating(true);
    setError(null);

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 30_000,
        });
      });

      const point: GeoPoint = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
      };

      const insideLinateAirport = isInsideLinateAirportArea(point);

      if (!isInsideMilanServiceArea(point) && !insideLinateAirport) {
        updateRoutePointError(
          'pickup',
          'Il servizio ROAd è disponibile nell’area di Milano e presso l’aeroporto di Linate.',
        );
        return;
      }

      let address: string | null = null;

      try {
        const result = await reverseGeocodeMilanPoint(point);
        const linateAirport = insideLinateAirport || isLinateAirportAddress(result.address);

        if (result.municipality === 'outside' && !linateAirport) {
          updateRoutePointError(
            'pickup',
            'La posizione attuale non si trova nell’area di servizio: Comune di Milano e Aeroporto di Linate.',
          );
          return;
        }

        address = result.address;
      } catch {
        // La posizione GPS rimane comunque utilizzabile.
      }
      const linateAirport = insideLinateAirport || isLinateAirportAddress(address);

      selectRoutePoint(
        'pickup',
        linateAirport ? LINATE_TERMINAL_POINT : point,
        address ?? (linateAirport ? 'Aeroporto di Milano Linate' : 'Posizione attuale'),
      );
    } catch (cause: unknown) {
      let message = 'Non è stato possibile recuperare la posizione attuale.';

      if (typeof cause === 'object' && cause !== null && 'code' in cause) {
        const code = (cause as { code?: number }).code;

        if (code === 1) {
          message = 'Accesso alla posizione negato. Abilitalo nelle impostazioni del browser.';
        } else if (code === 2) {
          message = 'La posizione del dispositivo non è disponibile.';
        } else if (code === 3) {
          message = 'Tempo scaduto durante la ricerca della posizione.';
        }
      }

      updateRoutePointError('pickup', message);
    } finally {
      setIsLocating(false);
    }
  }

  /** Il tocco sulla mappa riempie il primo posto libero: prima il ritiro, poi la destinazione. */
  /** La mappa accetta un punto solo quando un campo è attivo. */
  function onPick(point: GeoPoint): void {
    void selectRoutePointFromMap(point);
  }
  async function submit(): Promise<void> {
    if (session === null || pickup === null || destination === null || kind === null) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      if (kind === 'IMMEDIATE') {
        const submitted = await requestImmediateRide(session.accessToken, {
          pickup,
          pickupAddress,
          destination,
          destinationAddress,
        });

        setRequest(submitted);
        return;
      }

      const submitted = await requestAdvanceBooking(session.accessToken, {
        pickup,
        pickupAddress,
        destination,
        destinationAddress,
        scheduledPickup: new Date(scheduledPickup).toISOString(),
      });

      if (submitted.status === 'ACCEPTED') {
        /*
         * Una prenotazione accettata non è ancora una corsa live:
         * non viene assegnata a `request`.
         */
        resetRequest();
        setBookingConfirmation(submitted);

        await queryClient.invalidateQueries({
          queryKey: ['passenger-bookings', session.user.id],
        });

        return;
      }

      /*
       * Una prenotazione rifiutata può invece utilizzare la normale
       * vista conclusiva, che mostra l'indisponibilità del servizio.
       */
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

  async function cancelBooking(rideRequestId: string): Promise<void> {
    if (session === null) return;

    setCancellingBookingId(rideRequestId);
    setBookingsError(null);

    try {
      await cancelRide(session.accessToken, rideRequestId);

      if (bookingConfirmation?.id === rideRequestId) {
        setBookingConfirmation(null);
      }

      await queryClient.invalidateQueries({
        queryKey: ['passenger-bookings', session.user.id],
      });
    } catch (failure) {
      if (signOutIfExpired(failure)) return;

      setBookingsError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setCancellingBookingId(null);
    }
  }

  function openBookings(): void {
    setShowMenu(false);
    setShowProfile(false);
    setShowRoutePicker(false);
    setBookingsError(null);
    setShowBookings(true);
  }

  function startNewRequest(): void {
    resetRequest();
    setShowProfile(false);
    setShowMenu(false);
    setShowRoutePicker(true);
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
          {!showRoutePicker && (
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
                setActiveRoutePoint('pickup');
                setShowRoutePicker(true);
                setShowBookings(false);
                setBookingConfirmation(null);
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

              <span>Dove si va?</span>
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
              pickupAddress={pickupAddress}
              destinationAddress={destinationAddress}
              activePoint={activeRoutePoint}
              onActivePointChange={activateRoutePoint}
              pickupError={routePointErrors.pickup}
              destinationError={routePointErrors.destination}
              pickupWarning={routePointWarnings.pickup}
              destinationWarning={routePointWarnings.destination}
              onBack={returnToInitialView}
              onPointSelected={selectRoutePoint}
              onPointCleared={clearRoutePoint}
              isLocating={isLocating}
              onUseCurrentLocation={() => {
                void useCurrentLocation();
              }}
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

              {request === null && (
                <button
                  type="button"
                  className="menu-action"
                  data-testid="open-bookings"
                  onClick={openBookings}
                >
                  <span>Le mie prenotazioni</span>

                  <span
                    className="menu-action-count"
                    aria-label={`${passengerBookings.data?.bookings.length ?? 0} prenotazioni`}
                  >
                    {passengerBookings.data?.bookings.length ?? 0}
                  </span>
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
            key={mapResetKey}
            pickup={hidePickupOnMap ? null : pickup}
            destination={destination}
            focusDestination={rideCompleted}
            robotaxi={followingVehicle ? (vehicle.data?.vehicle?.position ?? null) : null}
            robotaxiHeadingTo={onBoard ? 'destination' : 'pickup'}
            onPick={
              request === null && showRoutePicker && activeRoutePoint !== null ? onPick : null
            }
          />

          {showProfile && request === null ? (
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
              onSessionExpired={signOutIfExpired}
            />
          ) : request !== null && view !== null ? (
            <StatusPanel
              request={request}
              view={view}
              connected={connection === 'connected'}
              cancelling={cancelling}
              cancellationError={cancellationError}
              onCancel={() => void cancelCurrentRide()}
              onNewRequest={resetRequest}
              nowMs={vehicle.dataUpdatedAt}
            />
          ) : showBookings ? (
            <BookingsPanel
              bookings={passengerBookings.data?.bookings ?? []}
              loading={passengerBookings.isPending}
              error={
                bookingsError ??
                (passengerBookings.error instanceof Error ? passengerBookings.error.message : null)
              }
              confirmedBookingId={bookingConfirmation?.id ?? null}
              cancellingBookingId={cancellingBookingId}
              onCancel={(rideRequestId) => void cancelBooking(rideRequestId)}
              onNewRequest={startNewRequest}
              onClose={() => setShowBookings(false)}
            />
          ) : bookingConfirmation !== null ? (
            <BookingConfirmationPanel
              booking={bookingConfirmation}
              onViewBookings={openBookings}
              onNewRequest={startNewRequest}
            />
          ) : pickup !== null && destination !== null ? (
            <RequestPanel
              pickup={pickup}
              destination={destination}
              kind={kind}
              scheduledPickup={scheduledPickup}
              busy={busy}
              error={error}
              onKindChange={setKind}
              onScheduledPickupChange={setScheduledPickup}
              onSubmit={() => void submit()}
            />
          ) : null}
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
