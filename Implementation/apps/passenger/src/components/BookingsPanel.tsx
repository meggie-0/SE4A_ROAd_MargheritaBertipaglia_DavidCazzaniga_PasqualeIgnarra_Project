import type { RideRequestResponse } from '@road/shared';
import { useState } from 'react';

export interface BookingsPanelProps {
  readonly bookings: readonly RideRequestResponse[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly confirmedBookingId: string | null;
  readonly cancellingBookingId: string | null;
  readonly onCancel: (rideRequestId: string) => void;
  readonly onNewRequest: () => void;
  readonly onClose: () => void;
}

function formatScheduledPickup(value: string | null): string {
  if (value === null) return 'Orario non disponibile';

  return new Date(value).toLocaleString('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPoint(address: string | null, point: RideRequestResponse['pickup']): string {
  return address ?? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

export function BookingsPanel({
  bookings,
  loading,
  error,
  confirmedBookingId,
  cancellingBookingId,
  onCancel,
  onNewRequest,
  onClose,
}: BookingsPanelProps): React.JSX.Element {
  const [bookingToCancel, setBookingToCancel] = useState<RideRequestResponse | null>(null);

  return (
    <section className="panel bookings-panel">
      <div className="bookings-heading">
        <div>
          <h2>Le mie prenotazioni</h2>
          <p>Corse programmate in attesa di attivazione</p>
        </div>

        <button
          type="button"
          className="bookings-close"
          aria-label="Chiudi le prenotazioni"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {confirmedBookingId !== null && (
        <div className="booking-confirmation" role="status">
          <strong>Prenotazione confermata</strong>
          <span>La corsa è stata programmata correttamente.</span>
        </div>
      )}

      {error !== null && (
        <p className="status-error" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="bookings-empty">Caricamento delle prenotazioni…</p>
      ) : bookings.length === 0 ? (
        <p className="bookings-empty">Non hai ancora corse programmate.</p>
      ) : (
        <div className="bookings-list">
          {bookings.map((booking) => (
            <article
              key={booking.id}
              className={`booking-card ${
                booking.id === confirmedBookingId ? 'booking-card--confirmed' : ''
              }`}
              data-testid={`booking-${booking.id}`}
            >
              <header className="booking-card-heading">
                <span className="booking-calendar" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <rect x="3" y="5" width="18" height="16" rx="2" />
                    <path d="M16 3v4M8 3v4M3 10h18" />
                  </svg>
                </span>

                <div>
                  <span>Corsa programmata</span>
                  <strong>{formatScheduledPickup(booking.scheduledPickup)}</strong>
                </div>
              </header>

              <dl className="booking-route">
                <dt>Partenza</dt>
                <dd>{formatPoint(booking.pickupAddress, booking.pickup)}</dd>

                <dt>Arrivo</dt>
                <dd>{formatPoint(booking.destinationAddress, booking.destination)}</dd>
              </dl>

              <button
                type="button"
                className="danger-button booking-cancel"
                disabled={cancellingBookingId !== null}
                onClick={() => setBookingToCancel(booking)}
              >
                {cancellingBookingId === booking.id
                  ? 'Annullamento in corso…'
                  : 'Annulla prenotazione'}
              </button>
            </article>
          ))}
        </div>
      )}

      <button type="button" className="booking-button" onClick={onNewRequest}>
        Prenota un’altra corsa
      </button>

      {bookingToCancel !== null && (
        <div className="confirmation-overlay">
          <div
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="booking-cancellation-title"
          >
            <h3 id="booking-cancellation-title">Annullare la prenotazione?</h3>

            <p>
              Vuoi annullare la corsa programmata per{' '}
              {formatScheduledPickup(bookingToCancel.scheduledPickup)}?
            </p>

            <div className="confirmation-actions">
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const rideRequestId = bookingToCancel.id;
                  setBookingToCancel(null);
                  onCancel(rideRequestId);
                }}
              >
                Sì, annulla
              </button>

              <button
                type="button"
                className="secondary-button"
                onClick={() => setBookingToCancel(null)}
              >
                No, mantienila
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
