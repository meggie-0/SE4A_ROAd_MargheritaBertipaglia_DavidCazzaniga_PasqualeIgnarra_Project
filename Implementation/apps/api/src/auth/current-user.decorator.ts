import { UnauthorizedException, createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { AuthenticatedUser } from './authenticated-user';

/**
 * Consegna al controller chi sta chiamando: `getProfile(@CurrentUser() user: AuthenticatedUser)`.
 *
 * Il controller non legge `request.user` da sé, e non è cosmesi: `request.user` è tipizzato `any`
 * da Express, quindi ogni lettura diretta sarebbe un punto in cui il tipo si perde in silenzio —
 * che è esattamente ciò che CLAUDE.md vieta con il divieto di `any`.
 *
 * Solleva 401 se il decoratore è usato su una rotta che `JwtAuthGuard` non protegge: come per
 * `RolesGuard`, una svista di configurazione deve fermare la richiesta, non consegnare al
 * controller un utente inesistente.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const { user } = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    if (user === undefined) {
      throw new UnauthorizedException('Questa risorsa richiede un token valido.');
    }
    return user;
  },
);
