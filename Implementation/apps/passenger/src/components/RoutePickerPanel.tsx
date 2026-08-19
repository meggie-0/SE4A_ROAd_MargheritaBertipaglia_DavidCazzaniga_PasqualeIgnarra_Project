import type { GeoPoint } from '@road/shared';
import { useEffect, useState } from 'react';

import { searchMilanAddresses, type AddressSuggestion } from '../address-search';

type RoutePoint = 'pickup' | 'destination';

export interface RoutePickerPanelProps {
  readonly pickup: GeoPoint | null;
  readonly destination: GeoPoint | null;
  readonly pickupAddress: string | null;
  readonly destinationAddress: string | null;
  readonly activePoint: RoutePoint | null;
  readonly onActivePointChange: (point: RoutePoint) => void;
  readonly onPointSelected: (pointType: RoutePoint, point: GeoPoint, address: string) => void;
  readonly isLocating: boolean;
  readonly onUseCurrentLocation: () => void;
  readonly onPointCleared: (pointType: RoutePoint) => void;
  readonly onBack: () => void;
  readonly pickupError: string | null;
  readonly destinationError: string | null;
  readonly pickupWarning: string | null;
  readonly destinationWarning: string | null;
}

export function RoutePickerPanel(props: RoutePickerPanelProps): React.JSX.Element {
  const [pickupQuery, setPickupQuery] = useState(displayValue(props.pickup, props.pickupAddress));
  const [destinationQuery, setDestinationQuery] = useState(
    displayValue(props.destination, props.destinationAddress),
  );
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const activeQuery =
    props.activePoint === 'pickup'
      ? pickupQuery
      : props.activePoint === 'destination'
        ? destinationQuery
        : '';

  const selectedValue =
    props.activePoint === 'pickup'
      ? displayValue(props.pickup, props.pickupAddress)
      : props.activePoint === 'destination'
        ? displayValue(props.destination, props.destinationAddress)
        : '';

  useEffect(() => {
    setPickupQuery(displayValue(props.pickup, props.pickupAddress));
  }, [props.pickup, props.pickupAddress]);

  useEffect(() => {
    setDestinationQuery(displayValue(props.destination, props.destinationAddress));
  }, [props.destination, props.destinationAddress]);

  useEffect(() => {
    const normalizedQuery = activeQuery.trim();

    if (normalizedQuery.length < 3 || normalizedQuery === selectedValue.trim()) {
      setSuggestions([]);
      setSearching(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;

    setSearching(true);
    setSearchError(null);

    void searchMilanAddresses(normalizedQuery)
      .then((results) => {
        if (!cancelled) {
          setSuggestions(results);
        }
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setSuggestions([]);
          setSearchError(
            failure instanceof Error ? failure.message : 'Ricerca degli indirizzi non riuscita.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setSearching(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeQuery, selectedValue]);

  function selectSuggestion(suggestion: AddressSuggestion): void {
    const pointType = props.activePoint;

    if (pointType === null) {
      return;
    }

    if (pointType === 'pickup') {
      setPickupQuery(suggestion.label);
    } else {
      setDestinationQuery(suggestion.label);
    }

    setSuggestions([]);
    setSearchError(null);

    props.onPointSelected(pointType, suggestion.point, suggestion.label);
  }

  return (
    <section
      id="route-search-dropdown"
      className="panel route-search-dropdown"
      aria-label="Imposta il percorso"
    >
      <div className="route-point-selector">
        <button
          type="button"
          className="route-back-button route-picker-back-button"
          aria-label="Torna alla pagina iniziale"
          onClick={props.onBack}
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
        <div
          className={`route-address-field route-address-field--pickup ${
            props.activePoint === 'pickup' ? 'route-address-field--active' : ''
          }`}
        >
          <span className="route-point-icon route-point-icon--pickup" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 21s6-5.25 6-11a6 6 0 1 0-12 0c0 5.75 6 11 6 11Z" />
              <circle cx="12" cy="10" r="2.25" />
            </svg>
          </span>

          <label className="route-address-copy" htmlFor="pickup-address">
            <small>Partenza</small>

            <input
              id="pickup-address"
              className="route-address-input"
              data-testid="pickup-address"
              type="search"
              value={pickupQuery}
              placeholder="Cerca un indirizzo"
              autoComplete="off"
              aria-autocomplete="list"
              aria-controls="address-suggestions"
              aria-expanded={props.activePoint === 'pickup' && suggestions.length > 0}
              onFocus={() => props.onActivePointChange('pickup')}
              onChange={(event) => {
                const nextValue = event.target.value;

                props.onActivePointChange('pickup');
                setPickupQuery(nextValue);

                if (nextValue.trim() === '') {
                  setSuggestions([]);
                  setSearchError(null);
                  props.onPointCleared('pickup');
                }
              }}
            />
          </label>
          {pickupQuery !== '' && (
            <button
              type="button"
              className="route-back-button route-clear-button"
              aria-label="Cancella il punto di partenza"
              onClick={() => {
                setPickupQuery('');
                setSuggestions([]);
                setSearchError(null);
                props.onPointCleared('pickup');
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
                <path d="M6 6l12 12" />
                <path d="M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>

        <div
          className={`route-address-field route-address-field--destination ${
            props.activePoint === 'destination' ? 'route-address-field--active' : ''
          }`}
        >
          <span className="route-point-icon route-point-icon--destination" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M6 21V4" />
              <path d="M6 5h10l-2 4 2 4H6" />
            </svg>
          </span>

          <label className="route-address-copy" htmlFor="destination-address">
            <small>Destinazione</small>

            <input
              id="destination-address"
              className="route-address-input"
              data-testid="destination-address"
              type="search"
              value={destinationQuery}
              placeholder="Cerca un indirizzo"
              autoComplete="off"
              aria-autocomplete="list"
              aria-controls="address-suggestions"
              aria-expanded={props.activePoint === 'destination' && suggestions.length > 0}
              onFocus={() => props.onActivePointChange('destination')}
              onChange={(event) => {
                const nextValue = event.target.value;

                props.onActivePointChange('destination');
                setDestinationQuery(nextValue);

                if (nextValue.trim() === '') {
                  setSuggestions([]);
                  setSearchError(null);
                  props.onPointCleared('destination');
                }
              }}
            />
          </label>
          {destinationQuery !== '' && (
            <button
              type="button"
              className="route-back-button route-clear-button"
              aria-label="Cancella la destinazione"
              onClick={() => {
                setDestinationQuery('');
                setSuggestions([]);
                setSearchError(null);
                props.onPointCleared('destination');
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
                <path d="M6 6l12 12" />
                <path d="M18 6 6 18" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {searching && (
        <p className="address-search-status" role="status">
          Ricerca in corso…
        </p>
      )}

      {searchError !== null && (
        <p className="address-search-error" role="alert">
          {searchError}
        </p>
      )}

      {!searching &&
        searchError === null &&
        activeQuery.trim().length >= 3 &&
        suggestions.length === 0 &&
        activeQuery.trim() !== selectedValue.trim() && (
          <p className="address-search-status">Nessun indirizzo trovato nell’area di Milano.</p>
        )}

      {(props.activePoint === 'pickup' || suggestions.length > 0) && (
        <ul
          id="address-suggestions"
          className="address-suggestions"
          role="listbox"
          aria-label="Indirizzi suggeriti"
        >
          {props.activePoint === 'pickup' && (
            <li role="none">
              <button
                type="button"
                role="option"
                className="address-suggestion current-location-option"
                disabled={props.isLocating}
                onClick={props.onUseCurrentLocation}
              >
                <span
                  className="route-point-marker route-point-marker--pickup"
                  aria-hidden="true"
                />

                <span>
                  {props.isLocating ? 'Ricerca della posizione…' : 'Usa la mia posizione'}
                </span>
              </button>
            </li>
          )}

          {suggestions.map((suggestion) => (
            <li key={suggestion.id} role="none">
              <button
                type="button"
                role="option"
                className="address-suggestion"
                data-testid="address-suggestion"
                onClick={() => selectSuggestion(suggestion)}
              >
                <span className="address-suggestion-icon" aria-hidden="true">
                  ●
                </span>

                <span>{suggestion.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {props.pickupError !== null && (
        <p className="route-point-error" role="alert">
          <strong>Partenza:</strong> {props.pickupError}
        </p>
      )}

      {props.destinationError !== null && (
        <p className="route-point-error" role="alert">
          <strong>Destinazione:</strong> {props.destinationError}
        </p>
      )}

      {props.pickupWarning !== null && (
        <p className="route-point-warning" role="status">
          <strong>Partenza:</strong> {props.pickupWarning}
        </p>
      )}

      {props.destinationWarning !== null && (
        <p className="route-point-warning" role="status">
          <strong>Destinazione:</strong> {props.destinationWarning}
        </p>
      )}

      <p className="address-search-attribution">Ricerca indirizzi © MapTiler</p>
    </section>
  );
}

function displayValue(point: GeoPoint | null, address: string | null): string {
  if (address !== null) {
    return address;
  }

  if (point !== null) {
    return `${point.lat.toFixed(5)}° N, ${point.lon.toFixed(5)}° E`;
  }

  return '';
}
