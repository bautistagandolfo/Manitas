import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthenticatedRequest } from './authenticated-request';
import type { JwtPayload } from '../../modules/auth/auth.service';
import { ACCESS_TOKEN_COOKIE } from '../../modules/auth/auth-cookie';

// Global (registrado como APP_GUARD en AppModule): toda ruta exige sesión
// salvo que esté marcada @Public(). No consulta la base en cada request
// (JWT stateless, BLUEPRINT §9.6) — como consecuencia, desactivar a un
// usuario no corta al instante una sesión que ya tenía el JWT emitido:
// queda viva hasta que expire (máximo 12h) o haga logout. Es la
// contrapartida esperable de no tener un store de sesiones ni blacklist
// de tokens, que el blueprint no pide.
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = (request.cookies as Record<string, string> | undefined)?.[
      ACCESS_TOKEN_COOKIE
    ];

    if (!token) {
      throw new UnauthorizedException('No hay sesión activa');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      request.user = { id: payload.sub, rol: payload.rol };
      return true;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
  }
}
