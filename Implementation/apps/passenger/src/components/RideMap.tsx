import { MILAN_ZONES, type GeoPoint } from '@road/shared';
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip, useMapEvents } from 'react-leaflet';

import 'leaflet/dist/leaflet.css';

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

export interface RideMapProps {
  readonly pickup: GeoPoint | null;
  readonly destination: GeoPoint | null;
  /** Riceve il punto toccato. `null` quando la schermata non accetta più scelte (corsa in corso). */
  readonly onPick: ((point: GeoPoint) => void) | null;
}

/**
 * Sulla mappa del passeggero **non** compare il robotaxi in movimento, ed è una scelta, non una
 * dimenticanza: la posizione dei veicoli si legge da `GET /fleet/status`, che è riservata
 * all'operatore (R7), e non viaggia sul canale push perché cambia a ogni tick. Il passeggero segue
 * la corsa attraverso le notifiche — assegnato, in avvicinamento con i minuti stimati, arrivato —
 * che è esattamente ciò che R6 gli promette. Mostrargli il puntino richiederebbe una rotta nuova,
 * cioè una funzionalità che nessun requisito chiede.
 */
export function RideMap({ pickup, destination, onPick }: RideMapProps): React.JSX.Element {
  return (
    <MapContainer
      className="ride-map"
      center={[MILAN_CENTER.lat, MILAN_CENTER.lon]}
      zoom={INITIAL_ZOOM}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      <MapClickHandler onPick={onPick} />

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
        <CircleMarker
          center={[pickup.lat, pickup.lon]}
          radius={10}
          pathOptions={{ color: '#22c55e', fillColor: '#22c55e', fillOpacity: 0.9 }}
        >
          <Popup>Punto di ritiro</Popup>
        </CircleMarker>
      )}

      {destination !== null && (
        <CircleMarker
          center={[destination.lat, destination.lon]}
          radius={10}
          pathOptions={{ color: '#f97316', fillColor: '#f97316', fillOpacity: 0.9 }}
        >
          <Popup>Destinazione</Popup>
        </CircleMarker>
      )}
    </MapContainer>
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
