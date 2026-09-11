import { ApiError, ApiTransportError, isRetriableFailure } from '../src/index.js';

/**
 * La regola di ripetizione che i due client condividono.
 *
 * Sta in `packages/shared` perché decide su `ApiError`, che è di lì: scritta due volte, una per
 * client, i due elenchi di codici divergerebbero al primo che qualcuno tocca.
 *
 * Il caso che conta davvero è il **401**, e la ragione non è il costo di una richiesta in più.
 * `@tanstack/react-query` tiene in stato `pending` — non `error` — una query che sta aspettando di
 * ritentare, e sospende i tentativi quando il documento non è visibile: un tentativo pendente su un
 * 401 lascia `error` a `null` a tempo indeterminato, e chi osserva l'errore per riportare al login
 * non viene mai svegliato.
 */
describe('Shared: quando vale la pena riprovare una richiesta fallita', () => {
  describe('Le risposte che il server ha rifiutato nel merito: mai', () => {
    it('401 non si riprova — un token scaduto resta scaduto', () => {
      expect(isRetriableFailure(new ApiError('Unauthorized', 401))).toBe(false);
    });

    it('403 non si riprova — il ruolo non cambia fra un tentativo e il successivo', () => {
      expect(isRetriableFailure(new ApiError('Forbidden', 403))).toBe(false);
    });

    it('409 non si riprova — lo stato è cambiato, e ritentare lo troverebbe cambiato uguale', () => {
      expect(isRetriableFailure(new ApiError('Conflict', 409))).toBe(false);
    });

    it('i due estremi della banda, 400 e 499, stanno dentro la regola', () => {
      expect(isRetriableFailure(new ApiError('Bad Request', 400))).toBe(false);
      expect(isRetriableFailure(new ApiError('Client Closed Request', 499))).toBe(false);
    });
  });

  describe('Ciò che è transitorio per natura: sì', () => {
    it('500 si riprova — un guasto del server può essere passato', () => {
      expect(isRetriableFailure(new ApiError('Internal server error', 500))).toBe(true);
    });

    it('503 si riprova — è il caso tipico di un backend che sta ripartendo', () => {
      expect(isRetriableFailure(new ApiError('Service Unavailable', 503))).toBe(true);
    });

    it('un errore di trasporto si riprova: la richiesta non è mai arrivata', () => {
      expect(isRetriableFailure(new ApiTransportError("Impossibile contattare l'API."))).toBe(true);
    });

    it('un errore che non viene dall’API si riprova, perché non sappiamo cosa sia', () => {
      expect(isRetriableFailure(new Error('boom'))).toBe(true);
      expect(isRetriableFailure(undefined)).toBe(true);
    });
  });

  /**
   * Il confine è sullo **stato**, non sul nome della classe: `ApiError` porta il codice, ed è quello
   * a decidere. Un 3xx non è un errore che questo client possa vedere — `fetch` segue i redirect —
   * ma se arrivasse non sarebbe un rifiuto nel merito, e la regola non deve fingere di saperlo.
   */
  it('uno stato fuori dalla banda 4xx resta riprovabile anche se è un ApiError', () => {
    expect(isRetriableFailure(new ApiError('Not Modified', 304))).toBe(true);
  });
});
