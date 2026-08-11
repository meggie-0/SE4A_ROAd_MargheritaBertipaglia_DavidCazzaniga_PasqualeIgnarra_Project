import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@road/shared';

import type { AuthenticatedUser } from './authenticated-user';
import { ROLES_METADATA_KEY } from './roles.decorator';

/**
 * Fa valere i ruoli dichiarati con `@Roles()`: 403 a chi ha un token valido ma del ruolo sbagliato.
 *
 * Due comportamenti che sembrano dettagli e non lo sono:
 *
 * - **senza `@Roles()` la rotta passa.** Il guard decide solo sull'*autorizzazione*; che serva o no
 *   un token lo decide `JwtAuthGuard`. Tenerli separati è ciò che permette a una rotta di essere
 *   autenticata e aperta a entrambi i ruoli (`GET /auth/me`) senza un terzo guard;
 * - **se `@Roles()` c'è ma nessuno ha autenticato, il guard rifiuta.** È il caso in cui qualcuno
 *   applica `RolesGuard` dimenticando `JwtAuthGuard`: `request.user` è assente, e l'alternativa —
 *   lasciar passare — trasformerebbe una svista di configurazione in una rotta operatore aperta a
 *   chiunque. Un guard che sbaglia deve sbagliare chiudendo.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // `getAllAndOverride`: il `@Roles()` sul metodo vince su quello del controller, che è ciò che
    // ci si aspetta quando una sola rotta di un controller operatore va aperta a tutti.
    const required = this.reflector.getAllAndOverride<readonly UserRole[] | undefined>(
      ROLES_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required === undefined || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (user === undefined) {
      throw new UnauthorizedException('Questa risorsa richiede un token valido.');
    }

    if (!required.includes(user.role)) {
      throw new ForbiddenException(
        `Questa risorsa è riservata a: ${required.join(', ')}. Il token è di un ${user.role}.`,
      );
    }

    return true;
  }
}
