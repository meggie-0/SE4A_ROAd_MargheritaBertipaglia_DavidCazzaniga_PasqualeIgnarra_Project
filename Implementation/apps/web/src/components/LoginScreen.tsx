import type { AuthResponse } from '@road/shared';
import { useState } from 'react';

import { login } from '../api';

/**
 * L'accesso dell'operatore di flotta (RASD R1).
 *
 * **Non c'è registrazione**, e non è un pezzo mancante: il RASD §1.4 elenca «Passenger
 * registration» e «Fleet operator login» senza la registrazione corrispondente, quindi gli account
 * operatore li fornisce l'amministrazione — in questo prototipo, il seed. Un modulo di iscrizione
 * qui creerebbe operatori che nessun requisito prevede.
 *
 * Un account passeggero che riuscisse a entrare non vedrebbe comunque nulla: tutte le rotte della
 * dashboard sono `@Roles('OPERATOR')` e rispondono 403. Il controllo che conta è quello, lato
 * server; qui si traduce il rifiuto in un messaggio comprensibile invece che in una schermata vuota.
 */

export interface LoginScreenProps {
  readonly onAuthenticated: (response: AuthResponse) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps): React.JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await login({ email, password });
      if (response.user.role !== 'OPERATOR') {
        setError('Questo account non è un account operatore.');
        return;
      }
      onAuthenticated(response);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel login-panel">
      <h1>ROAd — Dashboard operatore</h1>
      <p className="muted">Accedi con il tuo account operatore di flotta.</p>

      <form onSubmit={(event) => void submit(event)}>
        <label>
          Indirizzo email
          <input
            data-testid="email"
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            data-testid="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>

        {error !== null && (
          <p className="status-error" data-testid="auth-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" data-testid="submit-auth" disabled={busy}>
          Accedi
        </button>
      </form>
    </section>
  );
}
