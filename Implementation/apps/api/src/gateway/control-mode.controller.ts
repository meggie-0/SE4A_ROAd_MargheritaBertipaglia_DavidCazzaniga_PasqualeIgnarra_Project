import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { API_ROUTES, enableAutoModeRequestSchema, type EnableAutoModeRequest } from '@road/shared';

import { AllocationPort } from '../allocation/allocation.port';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth/access-control.port';
import { ModePort } from '../mode/mode.port';

import { EnableAutoModeRequestDto, ModeResponseDto } from './dto/mode.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Lettura del modo di controllo e rientro in modo Auto (RASD R12, R13; NFR9, NFR10).
 *
 * Due sole rotte, entrambe riservate all'operatore con i guard di M1b. La `GET` esiste perché NFR10
 * chiede che il modo sia sempre visibile sulla dashboard (DD §3.2) e NFR6 che lo sia insieme alla
 * strategia attiva al primo caricamento: per questo la risposta porta i due valori insieme, letti
 * dalle rispettive porte.
 *
 * Con loro viaggia il **livello di traffico** (decisione D75), che il RASD §2.3 mette fra i bisogni
 * dell'operatore accanto al modo operativo. Non aggiunge una lettura: esce dalla stessa chiamata del
 * modo, perché sono due colonne dello stesso record e lo stesso componente le possiede.
 *
 * **Non c'è una rotta per entrare in modo Manual**, e non è una dimenticanza: R13 lega il modo
 * Manual alla scelta di una politica — «if the Operator manually selects a specific allocation
 * strategy […] the system immediately transitions to Manual Mode» — quindi ci si entra da
 * `PUT /allocation/strategy`. Una rotta che portasse in Manual senza dire quale strategia usare
 * dovrebbe inventarne una, e nessun documento gliene dà il diritto.
 */
/**
 * Il nome è `ControlModeController` e non `ModeController` di proposito: quel nome, nel DD §2.2,
 * appartiene al **componente di dominio** che vive in `src/mode/`. Due classi omonime in due moduli
 * diversi si distinguerebbero solo dal percorso dell'import, e la prima volta che qualcuno importa
 * quella sbagliata il messaggio d'errore parlerebbe d'altro.
 */
@ApiTags('mode')
@Controller()
export class ControlModeController {
  constructor(
    private readonly mode: ModePort,
    /**
     * La strategia attiva la sa dire `allocation`, non `mode`: il DD §2.2.1 assegna
     * `getActiveStrategy()` all'`AllocationManager`, e comporre due letture in una risposta è
     * esattamente ciò che un gateway fa. Ciò che non fa è decidere: nessuna delle due porte viene
     * usata per altro che leggere e delegare.
     */
    private readonly allocation: AllocationPort,
  ) {}

  @Get(API_ROUTES.mode)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Legge il modo di controllo, la strategia attiva e il livello di traffico',
    description:
      'NFR10: il modo corrente è sempre visibile sulla dashboard. I tre valori vengono dal ' +
      'record `system_mode`, la loro unica sede autorevole, quindi due repliche del tier ' +
      'applicativo rispondono la stessa cosa (NFR3). Il livello di traffico esce dalla stessa ' +
      'lettura del modo (decisione D75) ed è `null` finché nessuna osservazione è arrivata.',
  })
  @ApiOkResponse({ type: ModeResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async getMode(): Promise<ModeResponseDto> {
    return this.currentMode();
  }

  @Put(API_ROUTES.mode)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('OPERATOR')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Riabilita il modo Auto',
    description:
      "R13: il sistema resta in Manual finché l'operatore non riabilita Auto esplicitamente. " +
      "Il rientro **rivaluta subito** l'ultimo livello di traffico noto e applica la strategia " +
      'che gli compete, quindi la strategia nella risposta può essere diversa da quella scelta a ' +
      'mano. Se il livello è Medium resta quella attiva in quell istante.',
  })
  @ApiBody({ type: EnableAutoModeRequestDto })
  @ApiOkResponse({ type: ModeResponseDto })
  @ApiBadRequestResponse({
    description:
      'Il corpo non è `{ "mode": "AUTO" }`. In particolare `MANUAL` viene rifiutato: in modo ' +
      'Manual ci si porta scegliendo una strategia su PUT /allocation/strategy (R13).',
  })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account operatore.' })
  async enableAuto(
    @Body(new ZodValidationPipe(enableAutoModeRequestSchema)) _body: EnableAutoModeRequest,
  ): Promise<ModeResponseDto> {
    await this.mode.enableAuto();

    // Si rilegge invece di riecheggiare la richiesta, come fa la `PUT` della strategia: la
    // risposta descrive lo stato del sistema **dopo** la rivalutazione, che è precisamente ciò che
    // il chiamante non poteva prevedere.
    return this.currentMode();
  }

  /**
   * Modo e strategia insieme: la coppia che il pannello di controllo mostra (DD §3.2).
   *
   * **Le due letture sono in sequenza, e il modo si legge per ultimo.** Sono due operazioni su due
   * porte diverse — il DD §2.2.1 assegna `getActiveStrategy()` all'`AllocationManager` e `getMode()`
   * al `ModeController` — quindi arrivano al record `system_mode` con due `SELECT` distinte, e fra le
   * due può committare una `setManual`. L'ordine decide quale disallineamento è possibile:
   *
   * - leggendo il modo per primo, la risposta potrebbe dire `AUTO` con la strategia appena scelta a
   *   mano: annuncerebbe all'operatore che il sistema è automatico un istante dopo che ha preso il
   *   controllo, che è la falsificazione di NFR10 nella §4.3 («an interleaving leaves Manual mode and
   *   the manual strategy out of step») mostrata a schermo;
   * - leggendo il modo per ultimo, il peggio che può capitare è `MANUAL` con la strategia
   *   precedente — cioè un modo già aggiornato e una strategia vecchia di un istante, che la
   *   richiesta successiva corregge.
   *
   * Fra i due errori possibili si sceglie quello che non nega mai un intervento umano già avvenuto.
   * L'alternativa esatta sarebbe una singola operazione che restituisce entrambi i valori, ma
   * nessuno dei due componenti a cui il DD affida le due letture ha titolo per esporla.
   *
   * **Le letture restano due anche col livello di traffico**, ed è il motivo per cui la decisione
   * D75 l'ha aggiunto a `getMode()` invece di dargli un lettore proprio: una terza `SELECT` avrebbe
   * allungato questa stessa analisi di un caso in più — un livello letto prima di un cambio di modo
   * e mostrato accanto a quello dopo — mentre così livello e modo provengono dalla stessa riga letta
   * nello stesso istante. Il disallineamento residuo resta quello di sopra, e riguarda la strategia.
   */
  private async currentMode(): Promise<ModeResponseDto> {
    const activeStrategy = await this.allocation.getActiveStrategy();
    const { mode, lastTrafficLevel } = await this.mode.getMode();
    return { mode, activeStrategy, trafficLevel: lastTrafficLevel };
  }
}
