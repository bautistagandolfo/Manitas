import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ColorsService } from './colors.service';
import { PrismaService } from '../../prisma/prisma.service';

type MockPrisma = {
  color: {
    create: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    color: { create: jest.fn(), findMany: jest.fn(), update: jest.fn() },
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

describe('ColorsService', () => {
  let prisma: MockPrisma;
  let service: ColorsService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new ColorsService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('ordena por nombre', async () => {
      prisma.color.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.color.findMany).toHaveBeenCalledWith({
        orderBy: { nombre: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('crea un color', async () => {
      prisma.color.create.mockResolvedValue({ id: 1, nombre: 'Negro' });

      const result = await service.create({ nombre: 'Negro' });

      expect(result).toEqual({ id: 1, nombre: 'Negro' });
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.color.create.mockRejectedValue(prismaUniqueViolation());

      await expect(service.create({ nombre: 'Negro' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('update', () => {
    it('actualiza un color', async () => {
      prisma.color.update.mockResolvedValue({ id: 1, nombre: 'Blanco' });

      const result = await service.update(1, { nombre: 'Blanco' });

      expect(result).toEqual({ id: 1, nombre: 'Blanco' });
    });

    it('traduce un id inexistente a NotFoundException', async () => {
      prisma.color.update.mockRejectedValue(prismaRecordNotFound());

      await expect(service.update(999, { nombre: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.color.update.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.update(1, { nombre: 'Blanco' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });
});
