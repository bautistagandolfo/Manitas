import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AuthService } from './auth.service';
import { PrismaService } from '../../prisma/prisma.service';

type MockPrisma = {
  user: { findUnique: jest.Mock };
};

const testUser = {
  id: 1,
  email: 'seller@manitas.local',
  nombre: 'Vendedor',
  rol: UserRole.SELLER,
  activo: true,
  passwordHash: '',
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('AuthService', () => {
  let prisma: MockPrisma;
  let service: AuthService;

  beforeAll(async () => {
    testUser.passwordHash = await argon2.hash('correct-password');
  });

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    const jwtService = new JwtService({
      secret: 'test-secret',
      signOptions: { expiresIn: '12h' },
    });
    service = new AuthService(prisma as unknown as PrismaService, jwtService);
  });

  describe('validateUser', () => {
    it('devuelve el usuario si el email y la contraseña son correctos', async () => {
      prisma.user.findUnique.mockResolvedValue(testUser);

      const result = await service.validateUser(
        'seller@manitas.local',
        'correct-password',
      );

      expect(result?.id).toBe(testUser.id);
    });

    it('devuelve null si la contraseña es incorrecta', async () => {
      prisma.user.findUnique.mockResolvedValue(testUser);

      const result = await service.validateUser(
        'seller@manitas.local',
        'wrong-password',
      );

      expect(result).toBeNull();
    });

    it('devuelve null si el email no existe (sin lanzar por hash inválido)', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      const result = await service.validateUser(
        'no-existe@manitas.local',
        'cualquier-cosa',
      );

      expect(result).toBeNull();
    });

    it('devuelve null si el usuario existe pero está inactivo, aunque la contraseña sea correcta', async () => {
      prisma.user.findUnique.mockResolvedValue({ ...testUser, activo: false });

      const result = await service.validateUser(
        'seller@manitas.local',
        'correct-password',
      );

      expect(result).toBeNull();
    });
  });

  describe('issueToken', () => {
    it('firma un JWT con sub y rol, y devuelve el usuario sin passwordHash', () => {
      const { token, user } = service.issueToken(testUser);

      const jwtService = new JwtService({ secret: 'test-secret' });
      const payload = jwtService.verify<{ sub: number; rol: string }>(token);

      expect(payload.sub).toBe(testUser.id);
      expect(payload.rol).toBe(testUser.rol);
      expect(user).toEqual({
        id: testUser.id,
        email: testUser.email,
        nombre: testUser.nombre,
        rol: testUser.rol,
      });
      expect((user as { passwordHash?: string }).passwordHash).toBeUndefined();
    });
  });
});
