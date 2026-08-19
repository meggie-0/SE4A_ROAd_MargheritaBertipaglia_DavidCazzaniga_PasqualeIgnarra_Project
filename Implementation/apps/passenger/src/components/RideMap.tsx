import { MILAN_ZONES, type GeoPoint } from '@road/shared';
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
  useMapEvents,
  useMap,
  Marker,
} from 'react-leaflet';

import { MILAN_SERVICE_BOUNDS } from '../service-area';

import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { divIcon } from 'leaflet';
import { fetchRoadRoute } from '../address-search';
/**
 * La mappa su cui l'app passeggero è centrata (DD §3.1).
 *
 * Il ritiro e la destinazione si scelgono **toccando la mappa**, e sono le prime due delle tre
 * interazioni con cui NFR6 chiede che una corsa si richieda da avvio a freddo. Un modulo con due
 * campi di indirizzo ne costerebbe molte di più e obbligherebbe a una geocodifica che nessun
 * requisito prevede.
 *
 * I marker sono `CircleMarker` e non `Marker`: l'icona di default di Leaflet è un'immagine
 * risolta a runtime rispetto al foglio di stile, e sotto un bundler finisce quasi sempre in un 404
 * silenzioso — un marker invisibile è il modo peggiore di sbagliare una mappa. Un cerchio è
 * disegnato dal browser e non ha assets.
 */

/** Il centro di Milano: Duomo. La mappa parte da lì perché è lì che il prototipo opera. */
const MILAN_CENTER: GeoPoint = { lat: 45.4642, lon: 9.19 };
const INITIAL_ZOOM = 13;
const PICKUP_MAP_ICON = divIcon({
  className: 'route-map-icon',
  html: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 22s7-6.1 7-13a7 7 0 1 0-14 0c0 6.9 7 13 7 13Z"
        fill="currentColor"
        stroke="white"
        stroke-width="1.2"
      />
      <circle cx="12" cy="9" r="2.5" fill="white" />
    </svg>
  `,
  iconSize: [34, 34],
  iconAnchor: [17, 34],
  popupAnchor: [0, -32],
});

const DESTINATION_MAP_ICON = divIcon({
  className: 'route-map-icon',
  html: `
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M6 22V3"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
      <path
        d="M7 4h11l-2.5 4L18 12H7Z"
        fill="currentColor"
        stroke="white"
        stroke-width="1.1"
        stroke-linejoin="round"
      />
    </svg>
  `,
  iconSize: [34, 34],
  iconAnchor: [7, 32],
  popupAnchor: [5, -30],
});

const ROBOTAXI_MAP_ICON = divIcon({
  className: 'robotaxi-map-icon',
  html: `
    <span
      class="road-taxi-icon robotaxi-map-symbol"
      aria-hidden="true"
    ></span>
  `,
  iconSize: [42, 42],
  iconAnchor: [21, 21],
  popupAnchor: [0, -21],
});

export interface RideMapProps {
  readonly pickup: GeoPoint | null;
  readonly destination: GeoPoint | null;
  /**
   * Dove si trova il robotaxi della corsa, quando ce n'è uno.
   *
   * Arriva da `GET /rides/:id/vehicle`, riletta a intervalli: è la sola cosa che l'app interroga
   * dopo la richiesta, perché una posizione cambia a ogni tick e sul canale push inonderebbe tutto
   * (decisione D69). Lo **stato** del veicolo non arriva di lì e non deve: quello è ciò che le
   * notifiche raccontano.
   */
  readonly robotaxi?: GeoPoint | null;
  /**
   * Verso quale dei due capi il veicolo sta andando: il ritiro prima della salita, la destinazione
   * dopo. Decide dove punta il segmento tratteggiato, e nient'altro.
   */
  readonly robotaxiHeadingTo?: 'pickup' | 'destination';
  /** Riceve il punto toccato. `null` quando la schermata non accetta più scelte (corsa in corso). */
  readonly onPick: ((point: GeoPoint) => void) | null;
  /** Sposta e ingrandisce la mappa sulla destinazione al termine della corsa. */
  readonly focusDestination?: boolean;
}

/**
 * Il segmento fra il robotaxi e il punto verso cui è diretto **non è il percorso** che farà.
 *
 * È una linea retta, tratteggiata proprio per non sembrare una strada: dice «viene da lì» prima
 * della salita e «stiamo andando là» dopo, e nulla più. Il percorso vero lo conosce il fornitore di
 * mappe e non esce dal backend, e disegnare una polilinea che sembrasse la rotta prometterebbe al
 * passeggero una precisione che il dato non ha — lo stesso errore che la decisione D46 vieta per
 * l'ETA, applicato alla mappa.
 */
export function RideMap({
  pickup,
  destination,
  robotaxi,
  robotaxiHeadingTo = 'pickup',
  focusDestination = false,
  onPick,
}: RideMapProps): React.JSX.Element {
  const heading = robotaxiHeadingTo === 'destination' ? destination : pickup;

  return (
    <MapContainer
      className="ride-map"
      center={[MILAN_CENTER.lat, MILAN_CENTER.lon]}
      zoom={INITIAL_ZOOM}
      minZoom={11}
      maxBounds={MILAN_SERVICE_BOUNDS}
      maxBoundsViscosity={1}
      zoomControl={false}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <MapClickHandler onPick={onPick} />
      <FitRouteBounds pickup={pickup} destination={destination} />
      <FocusDestination destination={destination} enabled={focusDestination} />

      {/* Le zone di Milano, dalla partizione di Voronoi condivisa (decisione D10): danno un
          riferimento a chi tocca la mappa senza conoscere la città. */}
      {MILAN_ZONES.map((zone) => (
        <CircleMarker
          key={zone.id}
          center={[zone.lat, zone.lon]}
          radius={4}
          pathOptions={{ color: '#475569', weight: 1, fillOpacity: 0.35 }}
        >
          <Tooltip>{zone.name}</Tooltip>
        </CircleMarker>
      ))}

      {pickup !== null && (
        <Marker position={[pickup.lat, pickup.lon]} icon={PICKUP_MAP_ICON}>
          <Popup>Punto di partenza</Popup>
        </Marker>
      )}

      {destination !== null && (
        <Marker position={[destination.lat, destination.lon]} icon={DESTINATION_MAP_ICON}>
          <Popup>Destinazione</Popup>
        </Marker>
      )}
      {robotaxi !== null && robotaxi !== undefined && (
        <>
          {heading !== null && <RobotaxiRoadRoute origin={robotaxi} destination={heading} />}
          <Marker position={[robotaxi.lat, robotaxi.lon]} icon={ROBOTAXI_MAP_ICON}>
            <Popup>Il tuo robotaxi</Popup>
          </Marker>
        </>
      )}
    </MapContainer>
  );
}

const ROUTE_REFRESH_CELL_DEGREES = 0.00025;

function RobotaxiRoadRoute({
  origin,
  destination,
}: {
  readonly origin: GeoPoint;
  readonly destination: GeoPoint;
}): React.JSX.Element | null {
  const [route, setRoute] = useState<readonly GeoPoint[]>([]);
  const latestOrigin = useRef(origin);

  latestOrigin.current = origin;

  /*
   * La cella cambia dopo uno spostamento di circa 20–30 metri.
   * Il marker continua invece ad aggiornarsi a ogni rilevazione.
   */
  const originCellLat = Math.round(origin.lat / ROUTE_REFRESH_CELL_DEGREES);
  const originCellLon = Math.round(origin.lon / ROUTE_REFRESH_CELL_DEGREES);

  const destinationLat = destination.lat;
  const destinationLon = destination.lon;

  useEffect(() => {
    const controller = new AbortController();
    const currentOrigin = latestOrigin.current;

    void fetchRoadRoute(
      currentOrigin,
      {
        lat: destinationLat,
        lon: destinationLon,
      },
      controller.signal,
    )
      .then((points) => {
        setRoute(points);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setRoute([]);
        }
      });

    return () => {
      controller.abort();
    };
  }, [originCellLat, originCellLon, destinationLat, destinationLon]);

  if (route.length < 2) {
    return null;
  }

  return (
    <Polyline
      positions={route.map((point): [number, number] => [point.lat, point.lon])}
      pathOptions={{
        color: '#2136ca',
        weight: 5,
        opacity: 0.85,
        lineCap: 'round',
        lineJoin: 'round',
      }}
    />
  );
}

/**
 * Traduce un tocco sulla mappa in un punto.
 *
 * Deve essere un componente figlio e non un `prop` di `MapContainer`: `useMapEvents` ha bisogno del
 * contesto che `MapContainer` fornisce ai discendenti.
 */
function MapClickHandler({ onPick }: { onPick: ((point: GeoPoint) => void) | null }): null {
  useMapEvents({
    click(event) {
      if (onPick === null) return;
      onPick({ lat: event.latlng.lat, lon: event.latlng.lng });
    },
  });
  return null;
}

function FitRouteBounds({
  pickup,
  destination,
}: {
  readonly pickup: GeoPoint | null;
  readonly destination: GeoPoint | null;
}): null {
  const map = useMap();

  useEffect(() => {
    if (pickup === null || destination === null) {
      return;
    }

    map.fitBounds(
      [
        [pickup.lat, pickup.lon],
        [destination.lat, destination.lon],
      ],
      {
        animate: true,
        duration: 0.7,
        maxZoom: 15,
        paddingTopLeft: [35, 220],
        paddingBottomRight: [35, 280],
      },
    );
  }, [map, pickup?.lat, pickup?.lon, destination?.lat, destination?.lon]);

  return null;
}

function FocusDestination({
  destination,
  enabled,
}: {
  readonly destination: GeoPoint | null;
  readonly enabled: boolean;
}): null {
  const map = useMap();

  useEffect(() => {
    if (!enabled || destination === null) {
      return;
    }

    map.flyToBounds(
      [
        [destination.lat, destination.lon],
        [destination.lat, destination.lon],
      ],
      {
        animate: true,
        duration: 1,
        maxZoom: 16,
        paddingTopLeft: [35, 220],
        paddingBottomRight: [35, 280],
      },
    );
  }, [map, enabled, destination?.lat, destination?.lon]);

  return null;
}
