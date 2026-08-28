import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';

import { ExternalServicesPort } from '../../../src/external/external-services.port';
import { ExternalModule } from '../../../src/external/external.module';
import { ClockPort } from '../../../src/platform/clock.port';
import { FakeClock } from '../../../src/platform/fake-clock';

/**
 * La sorgente di traffico **scriptata** (decisione D76; NFR8, R12, R13).
 *
 * Quello che questi casi difendono non è la tabella: è la **sostituibilità** che NFR8 promette. Fino
 * a qui il fornitore di traffico era uno solo, quindi «l'adapter si può cambiare senza toccare il
 * dominio» era un'affermazione che nessuno aveva mai messo alla prova. Un secondo adapter che
 * risponde alla stessa porta è quella prova.
 *
 * **Si passa da `ExternalServicesPort`, mai dalla classe** (HARNESS.md §9): è la stessa forma del
 * test dell'adapter orario, e qui vale doppio — se il test costruisse `ScriptedTrafficGateway` a
 * mano dimostrerebbe che quella classe legge una tabella, che è la metà meno interessante. Passando
 * dalla porta dimostra ciò che serve davvero, cioè che **la configurazione sceglie chi risponde** e
 * che chi chiede non se ne accorge.
 */

const START = '2026-05-04T09:00:00.000Z';

let moduleRef: TestingModule | null = null;
let clock: FakeClock;

/** Compone `external` con la sorgente scriptata e la tabella data. */
async function withScript(script: string | null): Promise<ExternalServicesPort> {
  clock = new FakeClock(START);
  moduleRef = await Test.createTestingModule({
    imports: [
      // La configurazione arriva da qui e non da `process.env`: un test che scrivesse variabili
      // d'ambiente vere le lascerebbe agli altri file della suite.
      ConfigModule.forRoot({
        ignoreEnvFile: true,
        load: [
          () => ({
            TRAFFIC_SOURCE: 'scripted',
            ...(script === null ? {} : { TRAFFIC_SCRIPT: script }),
          }),
        ],
      }),
      ExternalModule,
    ],
  })
    .overrideProvider(ClockPort)
    .useValue(clock)
    .compile();

  return moduleRef.get(ExternalServicesPort);
}

/** Il livello dopo N secondi dall'avvio del processo. */
async function levelAfter(external: ExternalServicesPort, seconds: number): Promise<string> {
  clock.setNow(new Date(new Date(START).getTime() + seconds * 1000));
  return external.getTraffic();
}

afterEach(async () => {
  await moduleRef?.close();
  moduleRef = null;
});

describe('[NFR8] La sorgente di traffico è sostituibile senza che il dominio se ne accorga', () => {
  it('segue la tabella oraria relativa all’avvio', async () => {
    const external = await withScript('LOW:0,MEDIUM:30,HIGH:60');

    expect(await levelAfter(external, 0)).toBe('LOW');
    expect(await levelAfter(external, 30)).toBe('MEDIUM');
    expect(await levelAfter(external, 60)).toBe('HIGH');
  });

  it('è relativa all’avvio e non a un orario assoluto', async () => {
    /**
     * È ciò che rende la dimostrazione riproducibile da terzi: lo stesso comando racconta la stessa
     * storia a qualunque ora venga eseguito. L'adapter orario — che resta il default — direbbe cose
     * diverse la mattina e la sera, ed è precisamente il motivo per cui lo scenario 3 non era
     * dimostrabile a comando.
     */
    const external = await withScript('LOW:0,HIGH:10');

    // Le tre del mattino: per l'adapter orario sarebbe `LOW` a qualunque secondo.
    expect(await levelAfter(external, 10)).toBe('HIGH');
  });

  it('tiene l’ultimo livello invece di ricominciare', async () => {
    /**
     * Una tabella ciclica farebbe ripartire la sequenza mentre l'operatore la sta ancora guardando,
     * e una dimostrazione che riparte da sola è indistinguibile da un sistema che oscilla — cioè dal
     * difetto che l'isteresi di NFR9 esiste per escludere.
     */
    const external = await withScript('LOW:0,HIGH:10');

    expect(await levelAfter(external, 10_000)).toBe('HIGH');
  });

  it('prima del primo gradino non lascia il livello indefinito', async () => {
    const external = await withScript('MEDIUM:30,HIGH:60');
    expect(await levelAfter(external, 0)).toBe('MEDIUM');
  });

  it('legge una tabella disordinata nell’ordine giusto', async () => {
    const external = await withScript('HIGH:60,LOW:0');

    expect(await levelAfter(external, 0)).toBe('LOW');
    expect(await levelAfter(external, 60)).toBe('HIGH');
  });
});

describe('[NFR8] Una tabella malformata non impedisce l’avvio', () => {
  /**
   * L'adapter si attiva solo in dimostrazione: un refuso in una variabile d'ambiente che impedisse
   * l'avvio dell'API trasformerebbe un errore di battitura in una demo che non parte davanti a chi
   * guarda. Si scarta ciò che non si capisce e si va avanti.
   */
  it('ignora i gradini illeggibili e usa quelli validi', async () => {
    const external = await withScript('LOW:0,PIOVOSO:15,MEDIUM:trenta,HIGH:60,LOW:-5');

    expect(await levelAfter(external, 15)).toBe('LOW');
    expect(await levelAfter(external, 60)).toBe('HIGH');
  });

  it('ricade sulla tabella di default quando non resta niente', async () => {
    const external = await withScript('niente-di-valido');

    // Il default è la sequenza dello scenario 3: LOW, poi MEDIUM a 30, poi HIGH a 60.
    expect(await levelAfter(external, 0)).toBe('LOW');
    expect(await levelAfter(external, 30)).toBe('MEDIUM');
    expect(await levelAfter(external, 60)).toBe('HIGH');
  });

  it('senza TRAFFIC_SCRIPT usa comunque la tabella di default', async () => {
    const external = await withScript(null);
    expect(await levelAfter(external, 60)).toBe('HIGH');
  });
});
