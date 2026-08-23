import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CategoriesService } from './categories.service';
import { PrismaService } from '../../prisma/prisma.service';

type MockPrisma = {
  category: {
    create: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    category: { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  };
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

describe('CategoriesService', () => {
  let prisma: MockPrisma;
  let service: CategoriesService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new CategoriesService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('ordena por nombre', async () => {
      prisma.category.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.category.findMany).toHaveBeenCalledWith({
        orderBy: { nombre: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('crea una categoría', async () => {
      prisma.category.create.mockResolvedValue({ id: 1, nombre: 'Remeras' });

      const result = await service.create({ nombre: 'Remeras' });

      expect(result).toEqual({ id: 1, nombre: 'Remeras' });
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.category.create.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.create({ nombre: 'Remeras' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('actualiza una categoría', async () => {
      prisma.category.update.mockResolvedValue({ id: 1, nombre: 'Pantalones' });

      const result = await service.update(1, { nombre: 'Pantalones' });

      expect(result).toEqual({ id: 1, nombre: 'Pantalones' });
    });

    it('traduce un id inexistente a NotFoundException', async () => {
      prisma.category.update.mockRejectedValue(prismaRecordNotFound());

      await expect(service.update(999, { nombre: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.category.update.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.update(1, { nombre: 'Pantalones' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
