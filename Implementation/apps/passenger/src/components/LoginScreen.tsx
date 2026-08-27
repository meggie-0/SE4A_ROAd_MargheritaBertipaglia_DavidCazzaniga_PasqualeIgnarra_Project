import { MIN_PASSWORD_LENGTH, type AuthResponse } from '@road/shared';
import { useState } from 'react';

import { login, register } from '../api';

/**
 * Registrazione e accesso del passeggero (RASD R1, G1).
 *
 * Una schermata sola con due modi, e non due pagine con un collegamento fra loro: chi apre l'app
 * per la prima volta e chi torna vogliono la stessa cosa — entrare — e la differenza è di due campi.
 *
 * Il ruolo non compare da nessuna parte: `POST /auth/register` crea sempre un `PASSENGER`, perché
 * il RASD §1.4 non prevede l'iscrizione pubblica di un operatore. Un selettore di ruolo qui
 * chiederebbe all'utente una cosa che il backend ignora.
 */

export interface LoginScreenProps {
  readonly onAuthenticated: (response: AuthResponse) => void;
}

export function LoginScreen({ onAuthenticated }: LoginScreenProps): React.JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [surname, setSurname] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response =
        mode === 'login'
          ? await login({ email, password })
          : await register({ email, password, name, surname });
      onAuthenticated(response);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel login-panel">
      {/*
       * `h2` e non `h1`: il titolo della pagina è il prodotto — «ROAd — App passeggero», che
       * l'intestazione dichiara sopra — e questo è il titolo di *un pannello dentro* quella pagina.
       * Con due `h1` la gerarchia direbbe che la schermata parla di due cose allo stesso livello.
       */}
      <h2 className="login-heading">
        {mode === 'login' ? 'Accedi per richiedere una corsa' : 'Crea un account'}
      </h2>
      <form onSubmit={(event) => void submit(event)}>
        {mode === 'register' && (
          <>
            <label>
              Nome
              <input
                data-testid="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </label>
            <label>
              Cognome
              <input
                data-testid="surname"
                value={surname}
                onChange={(event) => setSurname(event.target.value)}
                required
              />
            </label>
          </>
        )}

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
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={MIN_PASSWORD_LENGTH}
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
          {mode === 'login' ? 'Accedi' : 'Registrati'}
        </button>
      </form>

      <button
        type="button"
        className="link-button"
        data-testid="toggle-auth-mode"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setError(null);
        }}
      >
        {mode === 'login' ? 'Non hai un account? Registrati' : 'Hai già un account? Accedi'}
      </button>
    </section>
  );
}
