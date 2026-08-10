import { API_ROUTES, HealthCheckError, fetchHealth, healthResponseSchema } from '../src/index.js';

/**
 * `fetchHealth` è il pezzo di codice che entrambi i client usano per leggere lo stato dell'API.
 * Sta in `packages/shared` perché nessun client possa essere tentato di importare qualcosa da
 * `apps/api` (CLAUDE.md Regola 1), e perché così è testabile senza rete.
 */
describe('Shared: contratto di GET /health', () => {
  const validPayload = {
    status: 'ok',
    service: 'road-api',
    version: '0.1.0',
    time: '2026-01-01T08:00:00.000Z',
  };

  const respondWith = (body: unknown, init: { ok?: boolean; status?: number } = {}) =>
    jest.fn(async () => ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }));

  it('chiama esattamente <base>/health', async () => {
    const fetchImpl = respondWith(validPayload);

    await fetchHealth('http://localhost:3000', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3000/health');
  });

  it('normalizza le barre finali della base URL', async () => {
    const fetchImpl = respondWith(validPayload);

    await fetchHealth('http://localhost:3000///', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3000/health');
  });

  it('restituisce la risposta validata', async () => {
    const health = await fetchHealth('http://localhost:3000', respondWith(validPayload));

    expect(health).toEqual(validPayload);
  });

  it('fallisce in modo tipizzato se il servizio risponde con un errore', async () => {
    const fetchImpl = respondWith({}, { ok: false, status: 503 });

    await expect(fetchHealth('http://localhost:3000', fetchImpl)).rejects.toBeInstanceOf(
      HealthCheckError,
    );
  });

  it('fallisce se la risposta non rispetta lo schema condiviso', async () => {
    const fetchImpl = respondWith({ status: 'degraded' });

    await expect(fetchHealth('http://localhost:3000', fetchImpl)).rejects.toThrow(
      /non conforme al contratto/,
    );
  });

  it('fallisce se il backend non è raggiungibile', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(fetchHealth('http://localhost:3000', fetchImpl)).rejects.toThrow(
      /Impossibile contattare/,
    );
  });

  it('lo schema rifiuta uno stato diverso da "ok"', () => {
    expect(healthResponseSchema.safeParse({ ...validPayload, status: 'ko' }).success).toBe(false);
  });

  it('la rotta è dichiarata una volta sola', () => {
    expect(API_ROUTES.health).toBe('/health');
  });
});
