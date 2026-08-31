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
    // Ticket nuevo (post Release Candidate) — `create`/`update` ahora
    // consultan `findMany` primero (chequeo de duplicado case/acento-
    // insensible, `esNombreDuplicado`). Default `[]` (sin duplicados)
    // para no romper los tests preexistentes que no le prestan
    // atención a esta consulta nueva — los que sí, la pisan con
    // `mockResolvedValueOnce`.
    color: {
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

    // Ticket nuevo (post Release Candidate) — hallazgo real, verificado
    // en vivo contra el backend real: "negro" se creaba como un color
    // NUEVO y distinto cuando ya existía "Negro" (@unique de Postgres
    // es case-sensitive). Sin esto, el catch de P2002 de arriba nunca
    // se dispara para este caso — el nombre en minúscula es, a nivel
    // de base, un valor DISTINTO al ya guardado.
    it('rechaza "negro" cuando ya existe "Negro" — mayúsculas distintas, mismo color', async () => {
      prisma.color.findMany.mockResolvedValue([{ nombre: 'Negro' }]);

      await expect(service.create({ nombre: 'negro' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.color.create).not.toHaveBeenCalled();
    });

    it('rechaza "Bordo" (sin tilde) cuando ya existe "Bordó"', async () => {
      prisma.color.findMany.mockResolvedValue([{ nombre: 'Bordó' }]);

      await expect(service.create({ nombre: 'Bordo' })).rejects.toBeInstanceOf(
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

    // Ticket nuevo — mismo hallazgo que en `create`, aplicado a renombrar.
    it('rechaza renombrar a "blanco" cuando ya existe "Blanco" en OTRA fila', async () => {
      prisma.color.findMany.mockResolvedValue([{ nombre: 'Blanco' }]);

      await expect(
        service.update(1, { nombre: 'blanco' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.color.update).not.toHaveBeenCalled();
    });

    it('no se rechaza a sí misma: excluye la propia fila del chequeo (guardar sin cambiar el nombre)', async () => {
      // La propia consulta ya excluye `id: { not: id }` — este test
      // confirma que el mock refleja eso (nunca devuelve la fila 1
      // misma), así que renombrar "Blanco" a "Blanco" no choca consigo
      // mismo.
      prisma.color.findMany.mockResolvedValue([]);
      prisma.color.update.mockResolvedValue({ id: 1, nombre: 'Blanco' });

      await expect(service.update(1, { nombre: 'Blanco' })).resolves.toEqual({
        id: 1,
        nombre: 'Blanco',
      });
    });
  });
});
