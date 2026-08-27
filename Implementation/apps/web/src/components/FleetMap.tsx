import { MILAN_ZONES, type FleetVehicle, type RobotaxiState } from '@road/shared';
import {
  MapContainer,
  Marker,
  Popup,
  TileLayer,
  Tooltip,
  useMapEvents,
  useMap,
} from 'react-leaflet';
import { useEffect } from 'react';
import { STATE_APPEARANCE } from '../robotaxi-states';
import { divIcon } from 'leaflet';
import 'leaflet/dist/leaflet.css';

/**
 * La flotta viva sulla mappa (DD §3.2, RASD R7 e G8).
 *
 * «Mappa Leaflet con marker colorati per stato»: il colore viene da `STATE_APPEARANCE`, che è la
 * stessa sorgente che colora la status bar — così la legenda e la barra non possono contraddirsi.
 *
 * **L'icona di default di Leaflet non si usa mai**, ed è l'invariante da non perdere di vista: è
 * un'immagine risolta a runtime, e sotto un bundler diventa un 404 silenzioso. Un marker invisibile
 * su una mappa di monitoraggio è il difetto peggiore possibile — la flotta *sembra* vuota, e niente
 * segnala che non lo è.
 *
 * I marker sono quindi `Marker` con un `divIcon`, cioè **markup, non un'immagine**: la stessa
 * garanzia di prima ottenuta per un'altra via — prima era un cerchio SVG disegnato da Leaflet, ora è
 * HTML nostro — con in più il fatto che dentro ci sta un badge con l'icona di marca e un contorno
 * del colore dello stato. Se un giorno qualcuno tornasse a `new Marker()` senza `icon`, il difetto
 * di cui sopra tornerebbe con lui.
 *
 * Lo stato e l'identificatore del veicolo viaggiano sul badge come `data-state` e
 * `data-robotaxi-id`, nella stessa convenzione di `data-mode`, `data-strategy` e `data-traffic`: è
 * ciò su cui gli end-to-end asseriscono. Il colore da solo non basterebbe a nominarli — legarli alla
 * tinta rende un test verde o rosso a seconda di una scelta di palette.
 *
 * **Le posizioni arrivano per interrogazione periodica, non dal canale push**, e non è una
 * violazione di NFR2: le *transizioni* di stato arrivano push e ridipingono il marker subito; a
 * cambiare fra un giro e l'altro sono le coordinate, che si muovono a ogni tick del simulatore e
 * inonderebbero il canale (`FleetMonitorPort.recordPositions()`).
 */

const MILAN_CENTER = { lat: 45.4642, lon: 9.19 };
const INITIAL_ZOOM = 12;

const MILAN_MAP_BOUNDS: [[number, number], [number, number]] = [
  [45.39, 9.05],
  [45.54, 9.31],
];

const LINATE_TERMINAL_POINT = {
  lat: 45.4618,
  lon: 9.2786,
};
function createRobotaxiIcon(
  robotaxiId: string,
  state: RobotaxiState,
  color: string,
  selected: boolean,
) {
  return divIcon({
    className: 'robotaxi-marker',
    html: `
      <span
        class="robotaxi-marker-badge${selected ? ' robotaxi-marker-badge--selected' : ''}"
        style="--robotaxi-color: ${color}"
        data-robotaxi-id="${robotaxiId}"
        data-state="${state}"
      >
        <span class="robotaxi-marker-glyph"></span>
      </span>
    `,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

function createServiceZoneMapIcon(zoneId: string) {
  return divIcon({
    className: 'service-zone-map-icon',
    html: `
      <span
        class="service-zone-map-symbol service-zone-map-symbol--${zoneId}"
        style="--zone-icon: url('/zone-icons/${zoneId}.svg')"
        aria-hidden="true"
      ></span>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    tooltipAnchor: [0, -18],
  });
}

const SERVICE_ZONE_MARKERS = MILAN_ZONES.map((zone) => ({
  zone,
  icon: createServiceZoneMapIcon(zone.id),
}));

export interface FleetMapProps {
  readonly robotaxis: readonly FleetVehicle[];
  readonly selectedRobotaxiId: string | null;
  readonly onSelectRobotaxi: (robotaxiId: string) => void;
  readonly onClearSelection: () => void;
  readonly focusTarget: {
    readonly lat: number;
    readonly lon: number;
    readonly requestId: number;
  } | null;
}

interface ClearSelectionOnMapClickProps {
  readonly onClearSelection: () => void;
}

function FocusRobotaxi({
  target,
}: {
  readonly target: {
    readonly lat: number;
    readonly lon: number;
    readonly requestId: number;
  } | null;
}): null {
  const map = useMap();

  useEffect(() => {
    if (target === null) {
      return;
    }

    map.flyTo([target.lat, target.lon], 15, {
      animate: true,
      duration: 0.7,
    });
  }, [map, target]);

  return null;
}

function ClearSelectionOnMapClick({ onClearSelection }: ClearSelectionOnMapClickProps): null {
  useMapEvents({
    click: () => {
      onClearSelection();
    },
  });

  return null;
}

export function FleetMap({
  robotaxis,
  selectedRobotaxiId,
  focusTarget,
  onSelectRobotaxi,
  onClearSelection,
}: FleetMapProps): React.JSX.Element {
  return (
    <MapContainer
      className="fleet-map"
      center={[MILAN_CENTER.lat, MILAN_CENTER.lon]}
      zoom={INITIAL_ZOOM}
      minZoom={11}
      maxBounds={MILAN_MAP_BOUNDS}
      maxBoundsViscosity={1}
      zoomControl={false}
      scrollWheelZoom
    >
      <ClearSelectionOnMapClick onClearSelection={onClearSelection} />
      <FocusRobotaxi target={focusTarget} />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />

      {/* Le zone di Milano: la partizione di Voronoi su cui il riposizionamento ragiona
          (decisione D10). Sono il riferimento rispetto a cui l'operatore legge una concentrazione
          di veicoli o la sua assenza. */}
      {SERVICE_ZONE_MARKERS.map(({ zone, icon }) => {
        const position = zone.id === 'linate' ? LINATE_TERMINAL_POINT : zone;

        return (
          <Marker
            key={zone.id}
            position={[position.lat, position.lon]}
            icon={icon}
            alt={`Zona: ${zone.name}`}
            bubblingMouseEvents
            riseOnHover
            zIndexOffset={1000}
          >
            <Tooltip className="service-zone-tooltip" direction="top" offset={[0, -18]}>
              <strong>{zone.name}</strong>

              {zone.id === 'linate' && (
                <>
                  <br />
                  Terminal / Kiss&Ride
                </>
              )}
            </Tooltip>
          </Marker>
        );
      })}

      {robotaxis.map((vehicle) => {
        const appearance = STATE_APPEARANCE[vehicle.state];
        const selected = vehicle.id === selectedRobotaxiId;
        return (
          <Marker
            key={vehicle.id}
            position={[vehicle.position.lat, vehicle.position.lon]}
            icon={createRobotaxiIcon(vehicle.id, vehicle.state, appearance.color, selected)}
            eventHandlers={{
              click: () => onSelectRobotaxi(vehicle.id),
            }}
            bubblingMouseEvents={false}
            zIndexOffset={selected ? 2000 : 0}
          >
            <Popup>
              <strong>{vehicle.id}</strong>
              <br />
              {appearance.label}
              <br />
              Zona: {vehicle.zoneId ?? '—'}
              {selected && (
                <>
                  <br />
                  <em>Robotaxi selezionato</em>
                </>
              )}
            </Popup>
          </Marker>
        );
      })}
    </MapContainer>
  );
}
