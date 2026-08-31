import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SizesService } from './sizes.service';
import { PrismaService } from '../../prisma/prisma.service';

type MockPrisma = {
  size: {
    create: jest.Mock;
    findMany: jest.Mock;
    update: jest.Mock;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    // Ticket nuevo (post Release Candidate) — `create`/`update` ahora
    // consultan `findMany` primero (chequeo de duplicado case/acento-
    // insensible, `esNombreDuplicado`). Default `[]` para no romper los
    // tests preexistentes que no le prestan atención a esta consulta —
    // los que sí, la pisan con `mockResolvedValueOnce`.
    size: {
      create: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
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

describe('SizesService', () => {
  let prisma: MockPrisma;
  let service: SizesService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new SizesService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('ordena por orden, no por nombre (S, M, L, XL — no alfabético)', async () => {
      prisma.size.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.size.findMany).toHaveBeenCalledWith({
        orderBy: { orden: 'asc' },
      });
    });
  });

  describe('create', () => {
    it('crea un talle con su orden', async () => {
      prisma.size.create.mockResolvedValue({ id: 1, nombre: 'M', orden: 2 });

      const result = await service.create({ nombre: 'M', orden: 2 });

      expect(prisma.size.create).toHaveBeenCalledWith({
        data: { nombre: 'M', orden: 2 },
      });
      expect(result).toEqual({ id: 1, nombre: 'M', orden: 2 });
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.size.create.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.create({ nombre: 'M', orden: 2 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // Ticket nuevo (post Release Candidate) — mismo hallazgo real
    // verificado en vivo en `colors.service.ts`. Aplica igual a talles
    // con letra ("m" vs "M") — con talles numéricos ("1", "38") el
    // riesgo real es más bajo, pero el chequeo cubre ambos por igual.
    it('rechaza "m" cuando ya existe "M" — mayúsculas distintas, mismo talle', async () => {
      prisma.size.findMany.mockResolvedValue([{ nombre: 'M' }]);

      await expect(
        service.create({ nombre: 'm', orden: 2 }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.size.create).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('actualiza un talle', async () => {
      prisma.size.update.mockResolvedValue({ id: 1, nombre: 'M', orden: 3 });

      const result = await service.update(1, { orden: 3 });

      expect(result).toEqual({ id: 1, nombre: 'M', orden: 3 });
    });

    it('traduce un id inexistente a NotFoundException', async () => {
      prisma.size.update.mockRejectedValue(prismaRecordNotFound());

      await expect(service.update(999, { orden: 1 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.size.update.mockRejectedValue(prismaUniqueViolation());

      await expect(service.update(1, { nombre: 'L' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    // Ticket nuevo — mismo hallazgo que en `create`, aplicado a renombrar.
    it('rechaza renombrar a "l" cuando ya existe "L" en OTRA fila', async () => {
      prisma.size.findMany.mockResolvedValue([{ nombre: 'L' }]);

      await expect(service.update(1, { nombre: 'l' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.size.update).not.toHaveBeenCalled();
    });
  });
});
