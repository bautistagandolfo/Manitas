import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BrandsService } from './brands.service';
import { PrismaService } from '../../prisma/prisma.service';

type MockPrisma = {
  brand: {
    create: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    brand: { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
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

describe('BrandsService', () => {
  let prisma: MockPrisma;
  let service: BrandsService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new BrandsService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('ordena por nombre', async () => {
      prisma.brand.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.brand.findMany).toHaveBeenCalledWith({
        orderBy: { nombre: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('crea una marca', async () => {
      prisma.brand.create.mockResolvedValue({ id: 1, nombre: 'Nike' });

      const result = await service.create({ nombre: 'Nike' });

      expect(result).toEqual({ id: 1, nombre: 'Nike' });
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.brand.create.mockRejectedValue(prismaUniqueViolation());

      await expect(service.create({ nombre: 'Nike' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('actualiza una marca', async () => {
      prisma.brand.update.mockResolvedValue({ id: 1, nombre: 'Adidas' });

      const result = await service.update(1, { nombre: 'Adidas' });

      expect(result).toEqual({ id: 1, nombre: 'Adidas' });
    });

    it('traduce un id inexistente a NotFoundException', async () => {
      prisma.brand.update.mockRejectedValue(prismaRecordNotFound());

      await expect(service.update(999, { nombre: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.brand.update.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.update(1, { nombre: 'Adidas' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
