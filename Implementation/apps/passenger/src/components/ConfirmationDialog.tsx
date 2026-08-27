import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ConfirmationDialogProps {
  readonly titleId: string;
  readonly title: string;
  readonly message: ReactNode;
  readonly confirmLabel: string;
  readonly dismissLabel: string;
  readonly dialogTestId?: string;
  readonly confirmTestId?: string;
  readonly dismissTestId?: string;
  readonly onConfirm: () => void;
  readonly onDismiss: () => void;
}

export function ConfirmationDialog({
  titleId,
  title,
  message,
  confirmLabel,
  dismissLabel,
  dialogTestId,
  confirmTestId,
  dismissTestId,
  onConfirm,
  onDismiss,
}: ConfirmationDialogProps): React.JSX.Element | null {
  const confirmationHost = document.querySelector<HTMLElement>('.passenger-app');

  if (confirmationHost === null) {
    return null;
  }

  return createPortal(
    <div className="confirmation-overlay">
      <div
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={dialogTestId}
      >
        <h3 id={titleId}>{title}</h3>

        <p>{message}</p>

        <div className="confirmation-actions">
          <button
            type="button"
            className="danger-button"
            data-testid={confirmTestId}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>

          <button
            type="button"
            className="secondary-button"
            data-testid={dismissTestId}
            onClick={onDismiss}
          >
            {dismissLabel}
          </button>
        </div>
      </div>
    </div>,
    confirmationHost,
  );
}
