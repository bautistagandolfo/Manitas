import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { AuthGuard } from './auth.guard';
import { ACCESS_TOKEN_COOKIE } from '../../modules/auth/auth-cookie';

function buildContext(request: {
  cookies?: Record<string, string>;
  user?: unknown;
}): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('AuthGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let jwtService: { verify: jest.Mock };
  let guard: AuthGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    jwtService = { verify: jest.fn() };
    guard = new AuthGuard(
      reflector as unknown as Reflector,
      jwtService as unknown as JwtService,
    );
  });

  it('permite el paso sin chequear cookie si la ruta es @Public()', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    const context = buildContext({});

    expect(guard.canActivate(context)).toBe(true);
    expect(jwtService.verify).not.toHaveBeenCalled();
  });

  it('rechaza si no hay cookie de sesión', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    const context = buildContext({ cookies: {} });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rechaza si el JWT es inválido o expiró', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    jwtService.verify.mockImplementation(() => {
      throw new Error('invalid token');
    });
    const context = buildContext({
      cookies: { [ACCESS_TOKEN_COOKIE]: 'un-token-cualquiera' },
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('permite el paso y puebla request.user con un JWT válido', () => {
    reflector.getAllAndOverride.mockReturnValue(false);
    jwtService.verify.mockReturnValue({ sub: 7, rol: UserRole.OWNER });
    const request: { cookies: Record<string, string>; user?: unknown } = {
      cookies: { [ACCESS_TOKEN_COOKIE]: 'valido' },
    };
    const context = buildContext(request);

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toEqual({ id: 7, rol: UserRole.OWNER });
  });
});
