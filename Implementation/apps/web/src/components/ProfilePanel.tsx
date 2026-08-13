import { MIN_PASSWORD_LENGTH, type UserProfile } from '@road/shared';
import { useState } from 'react';

import { updateProfile } from '../api';

/**
 * Il profilo dell'operatore di flotta (RASD R2, G1; DD §3.2 [v1.6], decisione D70).
 *
 * R2 attribuisce agli **utenti** — non ai soli passeggeri — la facoltà di aggiornare dati personali
 * e credenziali, e un operatore è un utente: senza questo pannello poteva cambiare la propria
 * password solo chiamando `PATCH /auth/me` a mano.
 *
 * **Non è un quinto pannello di comando e controllo.** Si apre dall'intestazione e prende il posto
 * dei pannelli laterali finché resta aperto; la mappa e la status bar — cioè la superficie di
 * monitoraggio, che NFR10 e R7 vogliono sempre visibile — restano dove sono.
 *
 * È il gemello di quello dell'app passeggero, e la duplicazione è la stessa scelta deliberata di
 * `session.ts`: metterlo in comune vorrebbe dire un import fra `apps/*`, che la Regola 1 vieta.
 *
 * **La password si manda solo se è stata scritta.** Un campo vuoto non finisce nel corpo: mandare
 * una stringa vuota significherebbe chiedere al backend di impostare una password vuota, che lo
 * schema condiviso rifiuta — con un errore su un campo che l'operatore non voleva toccare.
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
      <h2>Il tuo profilo</h2>

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
            className="link-button"
            data-testid="close-profile"
            onClick={onClose}
          >
            Chiudi
          </button>
        </div>
      </form>
    </section>
  );
}
