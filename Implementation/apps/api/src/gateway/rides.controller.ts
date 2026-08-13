import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  API_ROUTES,
  submitAdvanceBookingRequestSchema,
  submitImmediateRideRequestSchema,
  type SubmitAdvanceBookingRequest,
  type SubmitImmediateRideRequest,
} from '@road/shared';

import {
  CurrentUser,
  JwtAuthGuard,
  Roles,
  RolesGuard,
  type AuthenticatedUser,
} from '../auth/access-control.port';
import type { BookingRecord, RideRequestRecord } from '../persistence/persistence.port';
import {
  RideNotCancellableError,
  RideRequestNotFoundError,
  RideRequestPort,
  ScheduledPickupNotInFutureError,
} from '../rides/rides.port';

import {
  AssignedVehicleResponseDto,
  RideRequestResponseDto,
  SubmitAdvanceBookingRequestDto,
  SubmitImmediateRideRequestDto,
} from './dto/rides.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Richiesta immediata, prenotazione anticipata e annullamento (RASD R3, R4, R14; G2, G3).
 *
 * Il controller non contiene logica di dominio: valida il corpo con lo schema condiviso, chiama
 * `RideRequestPort` e traduce gli errori tipizzati della porta nei codici HTTP corrispondenti.
 *
 * **Il passeggero è chi porta il token.** Nessuna delle tre rotte accetta un identificatore di
 * passeggero dal corpo o dall'indirizzo: lo prende da `@CurrentUser()`, e l'annullamento lo passa
 * alla porta come prova che chi annulla è chi ha richiesto. Un identificatore accettato dal client
 * permetterebbe di richiedere o annullare corse a nome di altri.
 *
 * **Una richiesta rifiutata non è un errore HTTP.** Se nessun veicolo è idoneo, la risposta è 201
 * con `status: REJECTED`: il RASD (Figura 3.1) prevede il rifiuto come esito del caso d'uso, e la
 * richiesta viene comunque persistita — è il dato che dice quando la flotta è sottodimensionata.
 * I 4xx qui sotto riguardano solo ciò che il *client* ha sbagliato.
 */
@ApiTags('rides')
@Controller()
export class RidesController {
  constructor(private readonly rides: RideRequestPort) {}

  @Post(API_ROUTES.ridesImmediate)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PASSENGER')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Richiede una corsa immediata',
    description:
      'R3: il sistema persiste la richiesta, chiede i candidati alla flotta, li passa alla ' +
      'strategia attiva, riserva la finestra del veicolo scelto e lo porta ad `ASSIGNED`. Se ' +
      'nessun veicolo è idoneo la risposta è comunque 201, con `status: REJECTED`.',
  })
  @ApiBody({ type: SubmitImmediateRideRequestDto })
  @ApiCreatedResponse({ type: RideRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account passeggero.' })
  async submitImmediate(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(submitImmediateRideRequestSchema))
    body: SubmitImmediateRideRequest,
  ): Promise<RideRequestResponseDto> {
    const outcome = await this.rides.submitImmediate({
      passengerId: user.id,
      pickup: body.pickup,
      pickupAddress: body.pickupAddress,
      destination: body.destination,
      destinationAddress: body.destinationAddress,
    });

    return rideRequestResponseOf(outcome.request, outcome.accepted ? outcome.booking : null);
  }

  @Post(API_ROUTES.ridesAdvance)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PASSENGER')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Prenota una corsa per un orario futuro',
    description:
      'R4: i candidati vengono filtrati sulla timeline prima della scelta, e la prenotazione ' +
      'accettata scrive prenotazione e riserva nella stessa transazione (NFR4). Il veicolo **non** ' +
      "viene assegnato adesso: lo sarà poco prima dell'orario, e se nel frattempo non fosse più " +
      'idoneo il sistema ne sceglie un altro.',
  })
  @ApiBody({ type: SubmitAdvanceBookingRequestDto })
  @ApiCreatedResponse({ type: RideRequestResponseDto })
  @ApiBadRequestResponse({ description: "L'orario richiesto non è successivo ad adesso." })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account passeggero.' })
  async submitAdvance(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(submitAdvanceBookingRequestSchema))
    body: SubmitAdvanceBookingRequest,
  ): Promise<RideRequestResponseDto> {
    try {
      const outcome = await this.rides.submitAdvance({
        passengerId: user.id,
        pickup: body.pickup,
        pickupAddress: body.pickupAddress,
        destination: body.destination,
        destinationAddress: body.destinationAddress,
        scheduledPickup: new Date(body.scheduledPickup),
      });

      return rideRequestResponseOf(outcome.request, outcome.accepted ? outcome.booking : null);
    } catch (error) {
      if (error instanceof ScheduledPickupNotInFutureError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  @Post(API_ROUTES.rideCancel)
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PASSENGER')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Annulla una richiesta di corsa',
    description:
      'R14: la richiesta passa a `CANCELLED`, la riserva viene rilasciata e la finestra torna ' +
      'prenotabile; se un veicolo era già stato assegnato, torna disponibile. Non si può annullare ' +
      'una corsa già cominciata.',
  })
  @ApiParam({ name: 'rideRequestId', format: 'uuid' })
  @ApiOkResponse({ type: RideRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account passeggero.' })
  @ApiNotFoundResponse({ description: 'Nessuna richiesta con quell identificatore, per te.' })
  @ApiConflictResponse({
    description: 'La richiesta non è più attiva, oppure il veicolo è già in viaggio.',
  })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideRequestId') rideRequestId: string,
  ): Promise<RideRequestResponseDto> {
    try {
      const cancellation = await this.rides.cancel(rideRequestId, user.id);
      return rideRequestResponseOf(cancellation.request, cancellation.booking);
    } catch (error) {
      // «Non è tua» e «non esiste» danno lo stesso 404, ed è voluto: distinguerli permetterebbe di
      // scoprire quali corse esistono provando identificatori.
      if (error instanceof RideRequestNotFoundError) throw new NotFoundException(error.message);
      if (error instanceof RideNotCancellableError) throw new ConflictException(error.message);
      throw error;
    }
  }

  @Get(API_ROUTES.rideVehicle)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('PASSENGER')
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Dove si trova il robotaxi della propria corsa',
    description:
      "La posizione del veicolo assegnato, che l'app passeggero disegna sulla mappa mentre si " +
      'avvicina (DD §3.1). **Non porta lo stato del veicolo né quello della corsa**: quelli sono ' +
      'ciò che R6 promette e viaggiano sul canale push. Duplicarli qui darebbe al client un ' +
      'secondo modo di scoprire una transizione, e NFR2 — «senza che il client interroghi» — non ' +
      'sarebbe più osservabile. La risposta porta `vehicle: null` finché un veicolo non c è: una ' +
      'prenotazione accettata è riservata, non assegnata.',
  })
  @ApiParam({ name: 'rideRequestId', format: 'uuid' })
  @ApiOkResponse({ type: AssignedVehicleResponseDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiForbiddenResponse({ description: 'Serve un account passeggero.' })
  @ApiNotFoundResponse({ description: 'Nessuna richiesta con quell identificatore, per te.' })
  async getAssignedVehicle(
    @CurrentUser() user: AuthenticatedUser,
    @Param('rideRequestId') rideRequestId: string,
  ): Promise<AssignedVehicleResponseDto> {
    try {
      const located = await this.rides.getAssignedVehicle(rideRequestId, user.id);

      // L'unica trasformazione è la data, che diventa una stringa ISO 8601: il dominio lavora con
      // `Date`, JSON no. Non c'è un istante della lettura da aggiungere — qui non c'è un orologio
      // da cui prenderlo (CLAUDE.md Regola 3), e per un veicolo che non c'è non ci sarebbe niente
      // da datare.
      return {
        vehicle:
          located === null
            ? null
            : {
                robotaxiId: located.robotaxiId,
                position: located.position,
                updatedAt: located.observedAt.toISOString(),
              },
      };
    } catch (error) {
      if (error instanceof RideRequestNotFoundError) throw new NotFoundException(error.message);
      throw error;
    }
  }
}

/**
 * Dal record persistito alla forma pubblica.
 *
 * Elenca i campi uno per uno e non è uno spread: il giorno in cui la riga prendesse una colonna in
 * più — un dato interno, un identificatore di un'altra tabella — non se la porterebbe fuori
 * dall'API senza che nessuno protesti. È la stessa disciplina di `robotaxiSnapshotOf()`.
 */
function rideRequestResponseOf(
  request: RideRequestRecord,
  booking: BookingRecord | null,
): RideRequestResponseDto {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    pickup: { lat: request.pickupLat, lon: request.pickupLon },
    pickupAddress: request.pickupAddress,
    destination: { lat: request.destinationLat, lon: request.destinationLon },
    destinationAddress: request.destinationAddress,
    assignedRobotaxiId: request.assignedRobotaxiId,
    scheduledPickup: booking?.scheduledPickup.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
  };
}
