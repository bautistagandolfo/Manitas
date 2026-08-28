import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ExpenseCategoriesService } from './expense-categories.service';
import { PrismaService } from '../../prisma/prisma.service';

// T6.1 — mismo patrón mecánico que `brands.service.spec.ts` (Prisma
// mockeado directo, sin `tx`: este servicio nunca abre una
// transacción de escritura, cada operación es un único `create`/
// `update`/`findMany`, mismo criterio que `brands`/`categories`).
type MockPrisma = {
  expenseCategory: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    expenseCategory: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
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

describe('ExpenseCategoriesService', () => {
  let prisma: MockPrisma;
  let service: ExpenseCategoriesService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new ExpenseCategoriesService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('ordena por nombre', async () => {
      prisma.expenseCategory.findMany.mockResolvedValue([]);

      await service.findAll();

      expect(prisma.expenseCategory.findMany).toHaveBeenCalledWith({
        orderBy: { nombre: 'asc' },
      });
    });
  });

  describe('create (RN-1, AD-7)', () => {
    it('crea una categoría', async () => {
      prisma.expenseCategory.create.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
      });

      const result = await service.create({ nombre: 'Limpieza' });

      expect(result).toEqual({ id: 1, nombre: 'Limpieza' });
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.expenseCategory.create.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.create({ nombre: 'Limpieza' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    // AD-7, literal: nunca "Mercadería" — probado con la tilde, sin
    // tilde, mayúsculas y como substring dentro de un nombre más largo,
    // para los tres patrones que el blueprint da como ejemplo.
    it.each([
      'Mercadería',
      'mercaderia',
      'MERCADERÍA',
      'Compra de mercadería para reventa',
      'Compra de ropa',
      'Pago a proveedores',
    ])('rechaza "%s" — alude a compra de mercadería (AD-7)', async (nombre) => {
      await expect(service.create({ nombre })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.expenseCategory.create).not.toHaveBeenCalled();
    });

    it('acepta un nombre que no alude a mercadería, aunque contenga palabras parecidas sueltas', async () => {
      prisma.expenseCategory.create.mockResolvedValue({
        id: 2,
        nombre: 'Insumos de oficina',
      });

      await expect(
        service.create({ nombre: 'Insumos de oficina' }),
      ).resolves.toBeDefined();
    });
  });

  describe('update (RN-1: bloqueada + AD-7)', () => {
    it('actualiza una categoría no bloqueada', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
        activo: true,
        bloqueada: false,
      });
      prisma.expenseCategory.update.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza y mantenimiento',
        activo: true,
        bloqueada: false,
      });

      const result = await service.update(1, {
        nombre: 'Limpieza y mantenimiento',
      });

      expect(result.nombre).toBe('Limpieza y mantenimiento');
      expect(prisma.expenseCategory.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { nombre: 'Limpieza y mantenimiento' },
      });
    });

    it('rechaza con NotFoundException si el id no existe', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue(null);

      await expect(service.update(999, { nombre: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('rechaza CUALQUIER cambio de nombre en una categoría bloqueada', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Alquiler',
        activo: true,
        bloqueada: true,
      });

      await expect(
        service.update(1, { nombre: 'Alquiler mensual' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('rechaza CUALQUIER cambio de activo en una categoría bloqueada', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Alquiler',
        activo: true,
        bloqueada: true,
      });

      await expect(service.update(1, { activo: false })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('rechaza un nombre que alude a mercadería, aunque la categoría NO esté bloqueada', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 5,
        nombre: 'Insumos de oficina',
        activo: true,
        bloqueada: false,
      });

      await expect(
        service.update(5, { nombre: 'Compra de mercadería' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.expenseCategory.update).not.toHaveBeenCalled();
    });

    it('traduce una violación de nombre único a ConflictException', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 1,
        nombre: 'Limpieza',
        activo: true,
        bloqueada: false,
      });
      prisma.expenseCategory.update.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.update(1, { nombre: 'Servicios' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('puede desactivar una categoría no bloqueada', async () => {
      prisma.expenseCategory.findUnique.mockResolvedValue({
        id: 6,
        nombre: 'Insumos de oficina',
        activo: true,
        bloqueada: false,
      });
      prisma.expenseCategory.update.mockResolvedValue({
        id: 6,
        nombre: 'Insumos de oficina',
        activo: false,
        bloqueada: false,
      });

      const result = await service.update(6, { activo: false });

      expect(result.activo).toBe(false);
    });
  });
});
