import { MIN_PASSWORD_LENGTH, type UserProfile } from '@road/shared';
import { useState } from 'react';

import { updateProfile } from '../api';

/**
 * Il profilo del passeggero (RASD R2, G1; `MILESTONES.md` §M8).
 *
 * R2 dice che «users will be able to update their personal information **and credentials**», e fino
 * a qui l'unico modo di farlo era chiamare `PATCH /auth/me` a mano: il requisito era realizzato nel
 * backend dal M1b e irraggiungibile da chi doveva usarlo. Questo pannello è il minimo che lo rende
 * vero — nome, cognome, telefono, indirizzo e password.
 *
 * **Perché è un pannello e non una schermata.** Il DD §3.1 descrive *la* schermata dell'app come
 * centrata sulla mappa, e non ne prevede altre: il profilo prende il posto del pannello di
 * richiesta sotto la stessa mappa, con un ritorno esplicito, invece di aprire una seconda pagina
 * con una barra di navigazione che il documento non disegna. Non è raggiungibile mentre una corsa è
 * in corso, per la stessa ragione per cui non lo è la scelta dei punti: lì lo schermo segue la
 * corsa.
 *
 * **La password si manda solo se è stata scritta.** Un campo vuoto non viene incluso nel corpo, e
 * non è un dettaglio: mandare una stringa vuota significherebbe chiedere al backend di impostare
 * una password vuota, che lo schema condiviso rifiuta — con un messaggio d'errore su un campo che
 * l'utente non voleva toccare.
 */

export interface ProfilePanelProps {
  readonly profile: UserProfile;
  readonly token: string;
  readonly onUpdated: (profile: UserProfile) => void;
  readonly onClose: () => void;
  /** Che fare se la sessione è scaduta mentre si compilava: la decide chi ci ha portato qui. */
  readonly onSessionExpired: (failure: unknown) => void;
}

export function ProfilePanel({
  profile,
  token,
  onUpdated,
  onClose,
  onSessionExpired,
}: ProfilePanelProps): React.JSX.Element {
  const [name, setName] = useState(profile.name);
  const [surname, setSurname] = useState(profile.surname);
  const [email, setEmail] = useState(profile.email);
  const [phoneNumber, setPhoneNumber] = useState(profile.phoneNumber ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSaved(false);
    setBusy(true);

    try {
      const updated = await updateProfile(token, {
        name,
        surname,
        email,
        // Vuoto significa «nessun numero», che nel contratto è `null` e non la stringa vuota.
        phoneNumber: phoneNumber.trim() === '' ? null : phoneNumber.trim(),
        ...(password === '' ? {} : { password }),
      });

      setPassword('');
      setSaved(true);
      onUpdated(updated);
    } catch (failure) {
      onSessionExpired(failure);
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel profile-panel">
      <div className="profile-panel-heading">
        <h2>Il tuo profilo</h2>

        <button
          type="button"
          className="route-back-button route-clear-button profile-close-button"
          aria-label="Chiudi profilo"
          onClick={onClose}
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
      </div>

      <form onSubmit={(event) => void submit(event)}>
        <label>
          Nome
          <input
            data-testid="profile-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </label>

        <label>
          Cognome
          <input
            data-testid="profile-surname"
            value={surname}
            onChange={(event) => setSurname(event.target.value)}
            required
          />
        </label>

        <label>
          Indirizzo email
          <input
            data-testid="profile-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>

        <label>
          Numero di telefono
          <input
            data-testid="profile-phone"
            value={phoneNumber}
            onChange={(event) => setPhoneNumber(event.target.value)}
            placeholder="facoltativo"
          />
        </label>

        <label>
          Nuova password
          <input
            data-testid="profile-password"
            type="password"
            autoComplete="new-password"
            minLength={MIN_PASSWORD_LENGTH}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="lascia vuoto per non cambiarla"
          />
        </label>

        {error !== null && (
          <p className="status-error" data-testid="profile-error" role="alert">
            {error}
          </p>
        )}

        {saved && (
          <p className="status-saved" data-testid="profile-saved" role="status">
            Profilo aggiornato.
          </p>
        )}

        <div className="actions">
          <button type="submit" data-testid="save-profile" disabled={busy}>
            {busy ? 'Salvataggio…' : 'Salva'}
          </button>
          <button
            type="button"
            className="profile-cancel-button"
            data-testid="close-profile"
            onClick={onClose}
          >
            Annulla
          </button>
        </div>
      </form>
    </section>
  );
}
