import { fetchHealth, type HealthResponse } from '@road/shared';
import { useEffect, useState } from 'react';

import { apiBaseUrl } from './api-base-url';

type Probe =
  { kind: 'loading' } | { kind: 'ok'; health: HealthResponse } | { kind: 'error'; message: string };

/**
 * Dashboard dell'operatore di flotta — in M0 solo lo scheletro.
 *
 * L'unico contenuto è lo stato letto da `GET /health`: serve a dimostrare che la catena
 * client → contratto HTTP → API funziona prima di scrivere qualsiasi logica di dominio.
 * Mappa Leaflet, pannello strategia e alert arrivano in M8 (DD §3.2).
 */
export function App(): React.JSX.Element {
  const [probe, setProbe] = useState<Probe>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;

    fetchHealth(apiBaseUrl)
      .then((health) => {
        if (!cancelled) setProbe({ kind: 'ok', health });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setProbe({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main>
      <h1>ROAd — Dashboard operatore</h1>
      <p>Walking skeleton (M0). Stato del backend letto da {apiBaseUrl}/health.</p>

      {probe.kind === 'loading' && <p data-testid="api-health-status">Interrogo l&apos;API…</p>}

      {probe.kind === 'error' && (
        <p className="status-error" data-testid="api-health-status">
          API non raggiungibile: {probe.message}
        </p>
      )}

      {probe.kind === 'ok' && (
        <dl>
          <dt>Stato</dt>
          <dd className="status-ok" data-testid="api-health-status">
            {probe.health.status}
          </dd>
          <dt>Servizio</dt>
          <dd>{probe.health.service}</dd>
          <dt>Versione</dt>
          <dd>{probe.health.version}</dd>
          <dt>Orario</dt>
          <dd>{probe.health.time}</dd>
        </dl>
      )}
    </main>
  );
}
