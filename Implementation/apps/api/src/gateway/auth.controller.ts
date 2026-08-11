import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  API_ROUTES,
  loginRequestSchema,
  registerRequestSchema,
  updateProfileRequestSchema,
  type LoginRequest,
  type RegisterRequest,
  type UpdateProfileRequest,
} from '@road/shared';

import { CurrentUser, JwtAuthGuard, type AuthenticatedUser } from '../auth/access-control.port';
import {
  AuthPort,
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  UnknownUserError,
  type AccountProfile,
  type AuthResult,
} from '../auth/auth.port';

import {
  AuthResponseDto,
  LoginRequestDto,
  RegisterRequestDto,
  UpdateProfileRequestDto,
  UserProfileDto,
} from './dto/auth.dto';
import { ZodValidationPipe } from './zod-validation.pipe';

/**
 * Registrazione, login e profilo (RASD R1, R2; G1).
 *
 * Il controller non contiene logica di dominio: valida il corpo con lo schema condiviso, chiama
 * `AuthPort` e traduce gli errori tipizzati della porta nei codici HTTP corrispondenti. È la
 * divisione che il DD §2.2 attribuisce all'API Gateway — «routes each call to the right manager
 * and enforces authentication» — ed è il motivo per cui questo file inietta la porta e mai
 * `AuthManager`.
 *
 * **Non c'è un `GET /auth/me`**, ed è una scelta. Leggere il profilo richiederebbe una quarta
 * operazione sulla porta, che il DD §2.2 non prevede, oppure una chiamata a `updateProfile()` con
 * una modifica vuota — cioè una lettura che passa dal cammino di scrittura, che è il genere di
 * scorciatoia che diventa un difetto il giorno in cui `update` toccherà una colonna di data. Il
 * profilo esce già da tutte e tre le operazioni: registrazione, login e aggiornamento lo
 * restituiscono, e tanto basta a R1 e R2. Se un client di M8 avrà bisogno di rileggerlo senza
 * rifare il login, la porta crescerà di un'operazione dichiarata, non di una scorciatoia.
 *
 * La traduzione degli errori sta qui e non in un filtro globale perché è specifica di queste
 * rotte: `EmailAlreadyRegisteredError` è un 409 sulla registrazione, ma altrove potrebbe non
 * esserlo. Un filtro globale imporrebbe la stessa mappa a tutti i moduli.
 */
@ApiTags('auth')
@Controller()
export class AuthController {
  constructor(private readonly auth: AuthPort) {}

  @Post(API_ROUTES.authRegister)
  @ApiOperation({
    summary: 'Registra un passeggero',
    description:
      'Crea un account `PASSENGER` e restituisce il primo access token. Il ruolo non è un ' +
      'parametro: il RASD prevede la registrazione dei soli passeggeri, mentre gli account ' +
      "operatore sono forniti dall'amministrazione del sistema.",
  })
  @ApiBody({ type: RegisterRequestDto })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiConflictResponse({ description: "L'indirizzo è già registrato." })
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
  ): Promise<AuthResponseDto> {
    try {
      return authResponseOf(
        await this.auth.register({
          email: body.email,
          password: body.password,
          name: body.name,
          surname: body.surname,
          phoneNumber: body.phoneNumber ?? null,
          role: 'PASSENGER',
        }),
      );
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        // Il messaggio conferma che quell'indirizzo è preso, ed è inevitabile: un'iscrizione che
        // non lo dicesse lascerebbe l'utente davanti a un errore che non sa risolvere. È il
        // motivo per cui il *login*, che non ha questa necessità, non distingue i due casi.
        throw new ConflictException(error.message);
      }
      throw error;
    }
  }

  @Post(API_ROUTES.authLogin)
  // 200 e non 201: il login non crea una risorsa, e in Nest una `POST` risponde 201 per default.
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Autentica un utente',
    description: 'Vale per entrambi i ruoli. Restituisce un solo access token, senza refresh.',
  })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Credenziali non valide.' })
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
  ): Promise<AuthResponseDto> {
    try {
      return authResponseOf(await this.auth.authenticate(body));
    } catch (error) {
      if (error instanceof InvalidCredentialsError) throw new UnauthorizedException(error.message);
      throw error;
    }
  }

  @Patch(API_ROUTES.authProfile)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('bearer')
  @ApiOperation({
    summary: 'Aggiorna il proprio profilo',
    description:
      'R2: informazioni personali e credenziali. Si può aggiornare **solo** il proprio profilo — ' +
      "l'utente da modificare viene dal token, non dal corpo della richiesta. La password nuova " +
      'non compare nella risposta, e il token in corso resta valido perché non porta nulla che ' +
      'questa operazione possa cambiare.',
  })
  @ApiBody({ type: UpdateProfileRequestDto })
  @ApiOkResponse({ type: UserProfileDto })
  @ApiUnauthorizedResponse({ description: 'Token assente, scaduto o non valido.' })
  @ApiConflictResponse({ description: 'Il nuovo indirizzo è già di un altro account.' })
  @ApiNotFoundResponse({ description: "L'account del token non esiste più." })
  async patchProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateProfileRequestSchema)) body: UpdateProfileRequest,
  ): Promise<UserProfileDto> {
    try {
      return profileDtoOf(await this.auth.updateProfile(user.id, body));
    } catch (error) {
      if (error instanceof UnknownUserError) throw new NotFoundException(error.message);
      if (error instanceof EmailAlreadyRegisteredError) throw new ConflictException(error.message);
      throw error;
    }
  }
}

/** Dal profilo del dominio al DTO: la `Date` diventa ISO 8601, come nel resto del contratto. */
function profileDtoOf(profile: AccountProfile): UserProfileDto {
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    surname: profile.surname,
    phoneNumber: profile.phoneNumber,
    role: profile.role,
    createdAt: profile.createdAt.toISOString(),
  };
}

function authResponseOf(result: AuthResult): AuthResponseDto {
  return {
    accessToken: result.token.accessToken,
    tokenType: 'Bearer',
    expiresInSeconds: result.token.expiresInSeconds,
    user: profileDtoOf(result.user),
  };
}
