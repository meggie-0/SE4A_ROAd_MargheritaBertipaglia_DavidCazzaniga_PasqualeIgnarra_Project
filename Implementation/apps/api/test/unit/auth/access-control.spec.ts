import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { Roles, RolesGuard, type AuthenticatedUser } from '../../../src/auth/access-control.port';

/**
 * Il meccanismo con cui il `gateway` fa valere i ruoli (M1b; RASD R1 «their respective
 * interfaces»).
 *
 * Qui si guarda la *decisione* del guard, isolata dal trasporto: chi passa, chi riceve 403, chi
 * riceve 401. Che la decisione arrivi davvero fino a una risposta HTTP lo dimostra il cancello di
 * M1b, che le stesse regole le esercita su un server vero con token veri.
 *
 * Tutto passa da `access-control.port.ts`, la seconda porta di `auth`: un test che raggiungesse
 * `roles.guard.ts` smetterebbe di dimostrare che il modulo è sostituibile (HARNESS.md §9), e
 * `pnpm arch` lo rifiuta.
 */

const PASSENGER: AuthenticatedUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'giulia.rossi@example.com',
  role: 'PASSENGER',
};

const OPERATOR: AuthenticatedUser = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'ada.operatrice@example.com',
  role: 'OPERATOR',
};

/**
 * Le rotte su cui il guard decide.
 *
 * Sono metodi decorati davvero con `@Roles()` e non metadati scritti a mano: `RolesGuard` li
 * rilegge con un `Reflector` vero, quindi il test copre anche il fatto che decoratore e guard
 * usino la stessa chiave — che è esattamente il genere di accordo implicito che si rompe in
 * silenzio.
 */
@Roles('OPERATOR')
class FixtureRoutes {
  /** Nessun `@Roles()` proprio: eredita quello del controller. */
  inheritsFromController(): void {}

  @Roles('PASSENGER')
  overridesWithPassenger(): void {}

  @Roles('PASSENGER', 'OPERATOR')
  openToBothRoles(): void {}
}

/** Una rotta senza alcun `@Roles()`, né sul metodo né sulla classe. */
class UnrestrictedRoutes {
  anyone(): void {}
}

type Handler = () => void;

function contextFor(
  target: object,
  handler: Handler,
  user: AuthenticatedUser | undefined,
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => target.constructor,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const guard = (): RolesGuard => new RolesGuard(new Reflector());

describe('[R1][G1] Role-based access control', () => {
  describe('Chi passa e chi no', () => {
    it('un OPERATOR passa su una rotta riservata agli operatori', () => {
      const routes = new FixtureRoutes();
      const context = contextFor(routes, routes.inheritsFromController, OPERATOR);

      expect(guard().canActivate(context)).toBe(true);
    });

    it('un PASSENGER riceve 403 sulla stessa rotta', () => {
      const routes = new FixtureRoutes();
      const context = contextFor(routes, routes.inheritsFromController, PASSENGER);

      expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
    });

    it('e viceversa: un OPERATOR riceve 403 su una rotta riservata ai passeggeri', () => {
      const routes = new FixtureRoutes();
      const context = contextFor(routes, routes.overridesWithPassenger, OPERATOR);

      expect(() => guard().canActivate(context)).toThrow(ForbiddenException);
    });

    it('una rotta che elenca entrambi i ruoli li ammette entrambi', () => {
      const routes = new FixtureRoutes();

      for (const user of [PASSENGER, OPERATOR]) {
        expect(guard().canActivate(contextFor(routes, routes.openToBothRoles, user))).toBe(true);
      }
    });
  });

  describe('I due casi che si dimenticano', () => {
    it('senza @Roles() la rotta passa: il guard decide sui ruoli, non sull autenticazione', () => {
      // Che serva o no un token lo decide `JwtAuthGuard`. Tenere separate le due decisioni è ciò
      // che permette a una rotta di essere autenticata e aperta a entrambi i ruoli senza inventare
      // un terzo guard.
      const routes = new UnrestrictedRoutes();

      expect(guard().canActivate(contextFor(routes, routes.anyone, undefined))).toBe(true);
    });

    it('con @Roles() ma senza utente autenticato rifiuta, invece di lasciar passare', () => {
      // È il caso di chi applica `RolesGuard` dimenticando `JwtAuthGuard`. L'alternativa —
      // considerare l'assenza di ruolo come «nessun vincolo» — trasformerebbe una svista di
      // configurazione in una rotta operatore aperta a chiunque. Un guard che sbaglia deve
      // sbagliare chiudendo.
      const routes = new FixtureRoutes();
      const context = contextFor(routes, routes.inheritsFromController, undefined);

      expect(() => guard().canActivate(context)).toThrow(UnauthorizedException);
    });
  });

  describe('Precedenza fra metodo e controller', () => {
    it('il @Roles() del metodo vince su quello del controller', () => {
      // `FixtureRoutes` è `@Roles('OPERATOR')`, ma `overridesWithPassenger` dichiara `PASSENGER`:
      // è il caso di una singola rotta da aprire a un ruolo diverso dal resto del controller.
      const routes = new FixtureRoutes();

      expect(
        guard().canActivate(contextFor(routes, routes.overridesWithPassenger, PASSENGER)),
      ).toBe(true);
      expect(() =>
        guard().canActivate(contextFor(routes, routes.inheritsFromController, PASSENGER)),
      ).toThrow(ForbiddenException);
    });
  });
});
