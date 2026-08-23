import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { RolesGuard } from './roles.guard';
import type { AuthenticatedRequest } from './authenticated-request';

function buildContext(user?: AuthenticatedRequest['user']): ExecutionContext {
  const request: AuthenticatedRequest = { user } as AuthenticatedRequest;
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => jest.fn(),
    getClass: () => jest.fn(),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('permite el paso si la ruta no tiene @Roles(...)', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const context = buildContext({ id: 1, rol: UserRole.SELLER });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rechaza si el rol del usuario no está en la lista requerida', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.OWNER]);
    const context = buildContext({ id: 1, rol: UserRole.SELLER });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('rechaza si no hay request.user (no debería pasar detrás de AuthGuard, pero no confía)', () => {
    reflector.getAllAndOverride.mockReturnValue([UserRole.OWNER]);
    const context = buildContext(undefined);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('permite el paso si el rol del usuario está en la lista requerida', () => {
    reflector.getAllAndOverride.mockReturnValue([
      UserRole.OWNER,
      UserRole.SELLER,
    ]);
    const context = buildContext({ id: 1, rol: UserRole.SELLER });

    expect(guard.canActivate(context)).toBe(true);
  });
});
