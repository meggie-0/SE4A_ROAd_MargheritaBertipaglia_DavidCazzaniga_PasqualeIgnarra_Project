import { MILAN_ZONES, type FleetVehicle } from '@road/shared';
import { CircleMarker, MapContainer, Popup, TileLayer, Tooltip } from 'react-leaflet';

import { STATE_APPEARANCE } from '../robotaxi-states';

import 'leaflet/dist/leaflet.css';

/**
 * La flotta viva sulla mappa (DD §3.2, RASD R7 e G8).
 *
 * «Mappa Leaflet con marker colorati per stato»: il colore viene da `STATE_APPEARANCE`, che è la
 * stessa sorgente che colora la status bar — così la legenda e la barra non possono contraddirsi.
 *
 * I marker sono `CircleMarker` e non `Marker` per la stessa ragione della mappa del passeggero:
 * l'icona di default di Leaflet è un'immagine risolta a runtime, e sotto un bundler diventa un 404
 * silenzioso. Un marker invisibile su una mappa di monitoraggio è il difetto peggiore possibile.
 *
 * **Le posizioni arrivano per interrogazione periodica, non dal canale push**, e non è una
 * violazione di NFR2: le *transizioni* di stato arrivano push e ridipingono il marker subito; a
 * cambiare fra un giro e l'altro sono le coordinate, che si muovono a ogni tick del simulatore e
 * inonderebbero il canale (`FleetMonitorPort.recordPositions()`).
 */

const MILAN_CENTER = { lat: 45.4642, lon: 9.19 };
const INITIAL_ZOOM = 12;

export interface FleetMapProps {
  readonly robotaxis: readonly FleetVehicle[];
}

export function FleetMap({ robotaxis }: FleetMapProps): React.JSX.Element {
  return (
    <MapContainer
      className="fleet-map"
      center={[MILAN_CENTER.lat, MILAN_CENTER.lon]}
      zoom={INITIAL_ZOOM}
      scrollWheelZoom
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Le zone di Milano: la partizione di Voronoi su cui il riposizionamento ragiona
          (decisione D10). Sono il riferimento rispetto a cui l'operatore legge una concentrazione
          di veicoli o la sua assenza. */}
      {MILAN_ZONES.map((zone) => (
        <CircleMarker
          key={zone.id}
          center={[zone.lat, zone.lon]}
          radius={5}
          pathOptions={{ color: '#334155', weight: 1, fillOpacity: 0.3 }}
        >
          <Tooltip>{zone.name}</Tooltip>
        </CircleMarker>
      ))}

      {robotaxis.map((vehicle) => {
        const appearance = STATE_APPEARANCE[vehicle.state];
        return (
          <CircleMarker
            key={vehicle.id}
            center={[vehicle.position.lat, vehicle.position.lon]}
            radius={8}
            pathOptions={{
              color: appearance.color,
              fillColor: appearance.color,
              fillOpacity: 0.85,
              weight: 2,
            }}
          >
            <Popup>
              <strong>{vehicle.id}</strong>
              <br />
              {appearance.label}
              <br />
              Zona: {vehicle.zoneId ?? '—'}
            </Popup>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
