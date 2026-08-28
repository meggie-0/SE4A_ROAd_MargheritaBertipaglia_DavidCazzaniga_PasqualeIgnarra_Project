import { TRAFFIC_LEVELS } from '@road/shared';

import { trafficAppearance, trafficExplanation, TRAFFIC_UNKNOWN } from '../src/traffic-levels';

/**
 * L'indicatore del traffico del pannello strategia (DD §3.2; RASD §2.3, R12, R13; NFR9).
 *
 * Il valore mostrato è facile; quello che questi casi difendono è la **frase**, perché è lì che
 * l'indicatore può mentire senza che nulla sollevi un errore. Un livello sbagliato si nota; una
 * spiegazione che attribuisce al sistema un comportamento che non ha, no — e verrebbe letta come
 * vera proprio da chi la usa per decidere se intervenire.
 */

describe('[R12] Il vocabolario del livello di traffico', () => {
  it('dà a ogni livello del dominio un aspetto, senza buchi', () => {
    // Se un giorno il RASD aggiungesse un quarto livello, questo caso fallirebbe invece di lasciare
    // il badge senza etichetta.
    for (const level of TRAFFIC_LEVELS) {
      expect(trafficAppearance(level).label).not.toHaveLength(0);
    }
  });

  it('distingue «non rilevato» da un livello basso', () => {
    /**
     * I due casi non vanno confusi, ed è la ragione per cui il campo è annullabile nel contratto.
     * Un sistema appena avviato non ha ancora interrogato il servizio di mappe: mostrare «basso»
     * sarebbe un'affermazione che nessuno ha verificato, e l'operatore la leggerebbe come una
     * misura.
     */
    expect(trafficAppearance(null)).toBe(TRAFFIC_UNKNOWN);
    expect(trafficAppearance(null).label).not.toBe(trafficAppearance('LOW').label);
  });

  it('non affida il significato al solo colore', () => {
    // Ogni livello porta un'etichetta testuale, e nessuna coincide con un'altra: il badge resta
    // leggibile a chi non distingue le tinte.
    const labels = TRAFFIC_LEVELS.map((level) => trafficAppearance(level).label);
    expect(new Set(labels).size).toBe(TRAFFIC_LEVELS.length);
  });
});

describe('[R12][NFR9] La spiegazione dice chi sta decidendo', () => {
  it('su Medium annuncia il suggerimento e nega la commutazione', () => {
    const note = trafficExplanation('MEDIUM', 'AUTO');

    /**
     * La banda morta è il caso in cui l'indicatore guadagna il suo posto: il sistema ha valutato e
     * ha deciso di **non** muoversi, che a schermo è indistinguibile dal non aver ancora valutato.
     * R12 chiede di suggerire ETA minimo senza applicarlo, e la frase deve dire entrambe le metà —
     * il suggerimento e il fatto che la scelta resta all'operatore.
     */
    expect(note).toMatch(/ETA minimo/);
    expect(note).toMatch(/non commuta/);
  });

  it('in Manual non attribuisce al sistema nessuna commutazione, qualunque sia il livello', () => {
    /**
     * Il difetto che questo caso impedisce.
     *
     * In Manual le osservazioni continuano a registrarsi (decisione D20) ma nessuna commuta niente
     * (R13). Una frase costruita sul solo livello direbbe «il sistema assegna in base al tempo di
     * arrivo» mentre il sistema sta seguendo la scelta dell'operatore: sarebbe falsa esattamente
     * nel momento in cui l'operatore ha preso il controllo.
     */
    for (const level of TRAFFIC_LEVELS) {
      const note = trafficExplanation(level, 'MANUAL');
      expect(note).toMatch(/Manual/);
      expect(note).not.toMatch(/il sistema assegna/);
    }
  });

  it('senza nessuna lettura spiega che il sistema non ha ancora valutato', () => {
    expect(trafficExplanation(null, 'AUTO')).toMatch(/Nessuna lettura/);
  });

  it('tace finché il modo non è noto, invece di indovinarlo', () => {
    // Con la risposta ancora in volo il livello si può mostrare, ma non chi lo sta usando: una
    // frase scritta ora avrebbe una probabilità su due di essere smentita un istante dopo.
    expect(trafficExplanation('HIGH', null)).toBeNull();
  });
});
