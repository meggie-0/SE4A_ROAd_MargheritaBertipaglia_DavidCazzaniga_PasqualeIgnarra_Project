import type { RideRequestResponse } from '@road/shared';

export interface BookingConfirmationPanelProps {
  readonly booking: RideRequestResponse;
  readonly onViewBookings: () => void;
  readonly onNewRequest: () => void;
}

function formatScheduledPickup(value: string | null): string {
  if (value === null) return 'Orario non disponibile';

  return new Date(value).toLocaleString('it-IT', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatPoint(address: string | null, point: RideRequestResponse['pickup']): string {
  return address ?? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

export function BookingConfirmationPanel({
  booking,
  onViewBookings,
  onNewRequest,
}: BookingConfirmationPanelProps): React.JSX.Element {
  return (
    <section className="panel booking-success-panel">
      <div className="booking-success-heading">
        <span className="booking-success-icon" aria-hidden="true">
          ✓
        </span>

        <div>
          <span>Prenotazione confermata</span>
          <h2>La corsa è programmata</h2>
        </div>
      </div>

      <div className="booking-success-time">
        <span>Data e ora del ritiro</span>
        <strong data-testid="confirmed-booking-time">
          {formatScheduledPickup(booking.scheduledPickup)}
        </strong>
      </div>

      <dl className="booking-success-route">
        <dt>Partenza</dt>
        <dd>{formatPoint(booking.pickupAddress, booking.pickup)}</dd>

        <dt>Arrivo</dt>
        <dd>{formatPoint(booking.destinationAddress, booking.destination)}</dd>
      </dl>

      <div className="booking-success-actions">
        <button
          type="button"
          className="booking-button"
          data-testid="view-bookings"
          onClick={onViewBookings}
        >
          Vedi le mie prenotazioni
        </button>

        <button
          type="button"
          className="secondary-button booking-success-secondary"
          data-testid="new-booking"
          onClick={onNewRequest}
        >
          Prenota un’altra corsa
        </button>
      </div>
    </section>
  );
}
