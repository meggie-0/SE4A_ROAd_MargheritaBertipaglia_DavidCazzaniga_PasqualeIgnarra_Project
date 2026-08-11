import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MIN_PASSWORD_LENGTH,
  USER_ROLES,
  type AuthResponse,
  type LoginRequest,
  type RegisterRequest,
  type UpdateProfileRequest,
  type UserProfile,
  type UserRole,
} from '@road/shared';

/**
 * I DTO che finiscono in `contracts/openapi.json` (M1b, RASD R1 e R2).
 *
 * Ognuno `implements` il tipo corrispondente di `packages/shared`: gli schemi Zod sono la sorgente
 * unica di verità, e il compilatore fallisce se contratto pubblicato e tipi condivisi divergono. I
 * decoratori qui descrivono, `ZodValidationPipe` fa rispettare — le due cose devono restare
 * d'accordo, e lo restano perché partono dallo stesso file.
 *
 * **Nessun DTO di risposta ha un campo password**, in chiaro o in hash. `UserProfileDto` è la sola
 * forma con cui un utente lascia il backend.
 */

export class RegisterRequestDto implements RegisterRequest {
  @ApiProperty({ format: 'email', maxLength: 320, example: 'giulia.rossi@example.com' })
  email!: string;

  @ApiProperty({
    minLength: MIN_PASSWORD_LENGTH,
    maxLength: 200,
    format: 'password',
    description: `Almeno ${MIN_PASSWORD_LENGTH} caratteri. Non viene mai restituita né registrata.`,
  })
  password!: string;

  @ApiProperty({ maxLength: 120, example: 'Giulia' })
  name!: string;

  @ApiProperty({ maxLength: 120, example: 'Rossi' })
  surname!: string;

  @ApiPropertyOptional({ maxLength: 40, example: '+39 333 1234567' })
  phoneNumber?: string;
}

export class LoginRequestDto implements LoginRequest {
  @ApiProperty({ format: 'email', example: 'giulia.rossi@example.com' })
  email!: string;

  @ApiProperty({ format: 'password' })
  password!: string;
}

export class UpdateProfileRequestDto implements UpdateProfileRequest {
  @ApiPropertyOptional({ format: 'email', maxLength: 320 })
  email?: string;

  @ApiPropertyOptional({ minLength: MIN_PASSWORD_LENGTH, maxLength: 200, format: 'password' })
  password?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  name?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  surname?: string;

  @ApiPropertyOptional({
    maxLength: 40,
    nullable: true,
    description: 'Ometterlo lo lascia invariato; `null` lo cancella.',
  })
  phoneNumber?: string | null;
}

export class UserProfileDto implements UserProfile {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  surname!: string;

  @ApiProperty({ nullable: true, type: String })
  phoneNumber!: string | null;

  @ApiProperty({ enum: USER_ROLES })
  role!: UserRole;

  @ApiProperty({ format: 'date-time', description: 'Istante di creazione, letto da ClockPort.' })
  createdAt!: string;
}

export class AuthResponseDto implements AuthResponse {
  @ApiProperty({ description: 'Access token JWT da inviare come header `Authorization: Bearer`.' })
  accessToken!: string;

  @ApiProperty({ enum: ['Bearer'], example: 'Bearer' })
  tokenType!: 'Bearer';

  @ApiProperty({
    description:
      'Durata del token in secondi. Non esiste refresh token: scaduto il token si rifà il login.',
  })
  expiresInSeconds!: number;

  @ApiProperty({ type: UserProfileDto })
  user!: UserProfileDto;
}
