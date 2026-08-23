import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

// Sin @Roles(...) en una ruta: alcanza con estar autenticado (cualquier
// rol). Con @Roles('OWNER'): RolesGuard exige ese rol exacto.
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
