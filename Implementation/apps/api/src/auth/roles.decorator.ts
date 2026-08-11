import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { UserRole } from '@road/shared';

/** La chiave sotto cui `@Roles()` scrive i ruoli ammessi e `RolesGuard` li rilegge. */
export const ROLES_METADATA_KEY = 'road:roles';

/**
 * I ruoli ammessi su una rotta o su un controller: `@Roles('OPERATOR')`.
 *
 * Da solo non protegge nulla — è metadato. A farlo valere è `RolesGuard`, che va applicato
 * **insieme** a `JwtAuthGuard` e dopo di esso.
 */
export function Roles(...roles: readonly [UserRole, ...UserRole[]]): CustomDecorator<string> {
  return SetMetadata(ROLES_METADATA_KEY, roles);
}
