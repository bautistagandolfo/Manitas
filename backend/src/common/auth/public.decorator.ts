import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

// Marca una ruta como accesible sin sesión. Todo lo demás exige un JWT
// válido — AuthGuard corre global (module-auth-spec.md, sección 3).
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_KEY, true);
