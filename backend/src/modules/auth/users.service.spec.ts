import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { PrismaService } from '../../prisma/prisma.service';

type MockPrisma = {
  user: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
};

function buildMockPrisma(): MockPrisma {
  const prisma: MockPrisma = {
    user: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  // $transaction(async (tx) => ...) — el mock ejecuta el callback pasándole
  // el mismo objeto mockeado, como hace Prisma en una transacción real.
  prisma.$transaction.mockImplementation(
    (callback: (tx: MockPrisma) => unknown) => callback(prisma),
  );

  return prisma;
}

function prismaUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });
}

function prismaRecordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record not found', {
    code: 'P2025',
    clientVersion: '6.19.3',
  });
}

describe('UsersService', () => {
  let prisma: MockPrisma;
  let service: UsersService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new UsersService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('hashea la contraseña antes de guardarla (nunca en texto plano)', async () => {
      let savedData: { passwordHash: string } | undefined;
      prisma.user.create.mockImplementation(
        ({ data }: { data: { passwordHash: string } }) => {
          savedData = data;
          return Promise.resolve({ id: 1, ...data });
        },
      );

      await service.create({
        email: 'a@b.com',
        password: 'plain-password',
        nombre: 'A',
        rol: UserRole.SELLER,
      });

      expect(savedData?.passwordHash).not.toBe('plain-password');
      expect(savedData?.passwordHash.length).toBeGreaterThan(20);
    });

    it('traduce una violación de email único a ConflictException', async () => {
      prisma.user.create.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.create({
          email: 'a@b.com',
          password: 'plain-password',
          nombre: 'A',
          rol: UserRole.SELLER,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.update(999, { activo: false }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza desactivar al último OWNER activo', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        rol: UserRole.OWNER,
        activo: true,
      });
      prisma.user.count.mockResolvedValue(0);

      await expect(service.update(1, { activo: false })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rechaza bajarle el rol a OWNER a SELLER si es el último activo', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        rol: UserRole.OWNER,
        activo: true,
      });
      prisma.user.count.mockResolvedValue(0);

      await expect(
        service.update(1, { rol: UserRole.SELLER }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('permite desactivar a un OWNER si hay otro OWNER activo', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        rol: UserRole.OWNER,
        activo: true,
      });
      prisma.user.count.mockResolvedValue(1);
      prisma.user.update.mockResolvedValue({ id: 1, activo: false });

      await service.update(1, { activo: false });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 1 }, data: { activo: false } }),
      );
    });

    it('no chequea el último OWNER al editar a un SELLER', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 2,
        rol: UserRole.SELLER,
        activo: true,
      });
      prisma.user.update.mockResolvedValue({ id: 2, activo: false });

      await service.update(2, { activo: false });

      expect(prisma.user.count).not.toHaveBeenCalled();
      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('permite editar campos de un OWNER activo que sigue siendo OWNER activo', async () => {
      prisma.user.findUnique.mockResolvedValue({
        id: 1,
        rol: UserRole.OWNER,
        activo: true,
      });
      prisma.user.update.mockResolvedValue({ id: 1, nombre: 'Nuevo nombre' });

      await service.update(1, { nombre: 'Nuevo nombre' });

      expect(prisma.user.count).not.toHaveBeenCalled();
    });
  });

  describe('resetPassword', () => {
    it('hashea la nueva contraseña', async () => {
      let savedData: { passwordHash: string } | undefined;
      prisma.user.update.mockImplementation(
        ({ data }: { data: { passwordHash: string } }) => {
          savedData = data;
          return Promise.resolve({ id: 1, ...data });
        },
      );

      await service.resetPassword(1, 'nueva-password');

      expect(savedData?.passwordHash).not.toBe('nueva-password');
    });

    it('traduce un usuario inexistente a NotFoundException', async () => {
      prisma.user.update.mockRejectedValue(prismaRecordNotFound());

      await expect(
        service.resetPassword(999, 'nueva-password'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
