import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CustomersService } from './customers.service';
import { PrismaService } from '../../prisma/prisma.service';

type MockPrisma = {
  customer: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
  };
  return: { findMany: jest.Mock };
  returnPayment: { groupBy: jest.Mock };
  payment: { groupBy: jest.Mock };
};

function buildMockPrisma(): MockPrisma {
  return {
    customer: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
    return: { findMany: jest.fn() },
    returnPayment: { groupBy: jest.fn() },
    payment: { groupBy: jest.fn() },
  };
}

function prismaUniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
  });
}

describe('CustomersService', () => {
  let prisma: MockPrisma;
  let service: CustomersService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new CustomersService(prisma as unknown as PrismaService);
  });

  describe('crear', () => {
    it('crea un cliente', async () => {
      prisma.customer.create.mockResolvedValue({
        id: 1,
        nombre: 'Carlos Martínez',
        dni: '30123456',
      });

      const result = await service.crear({
        nombre: 'Carlos Martínez',
        dni: '30123456',
      });

      expect(result).toEqual({
        id: 1,
        nombre: 'Carlos Martínez',
        dni: '30123456',
      });
      expect(prisma.customer.create).toHaveBeenCalledWith({
        data: { nombre: 'Carlos Martínez', dni: '30123456', telefono: null },
      });
    });

    it('traduce una violación de DNI único a ConflictException — el caso real que motivó el DNI (dos "Carlos Martínez")', async () => {
      prisma.customer.create.mockRejectedValue(prismaUniqueViolation());

      await expect(
        service.crear({ nombre: 'Carlos Martínez', dni: '30123456' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('buscar', () => {
    it('sin q, trae los últimos cargados primero', async () => {
      prisma.customer.findMany.mockResolvedValue([]);

      await service.buscar();

      expect(prisma.customer.findMany).toHaveBeenCalledWith({
        where: { activo: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    it('con q, busca por nombre o DNI (DNI normalizado, sin puntos)', async () => {
      prisma.customer.findMany.mockResolvedValue([]);

      await service.buscar('30.123.456');

      expect(prisma.customer.findMany).toHaveBeenCalledWith({
        where: {
          activo: true,
          OR: [
            { nombre: { contains: '30.123.456', mode: 'insensitive' } },
            { dni: { contains: '30123456' } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });
  });

  describe('creditoDisponible', () => {
    it('rechaza un cliente inexistente', async () => {
      prisma.customer.findUnique.mockResolvedValue(null);

      await expect(service.creditoDisponible(999)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('sin devoluciones, devuelve una lista vacía sin agregar nada más', async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: 1 });
      prisma.return.findMany.mockResolvedValue([]);

      const result = await service.creditoDisponible(1);

      expect(result).toEqual([]);
      expect(prisma.returnPayment.groupBy).not.toHaveBeenCalled();
    });

    it('suma crédito original menos consumido por devolución, y descarta las que ya están en $0', async () => {
      prisma.customer.findUnique.mockResolvedValue({ id: 1 });
      // Dos devoluciones del mismo cliente: la 100 con crédito
      // parcialmente consumido (queda saldo), la 200 totalmente
      // consumida (no debería aparecer en el resultado).
      prisma.return.findMany.mockResolvedValue([
        { id: 10, numero: 200 },
        { id: 9, numero: 100 },
      ]);
      prisma.returnPayment.groupBy.mockResolvedValue([
        { returnId: 9, _sum: { monto: new Prisma.Decimal('500.00') } },
        { returnId: 10, _sum: { monto: new Prisma.Decimal('300.00') } },
      ]);
      prisma.payment.groupBy.mockResolvedValue([
        { returnId: 9, _sum: { monto: new Prisma.Decimal('200.00') } },
        { returnId: 10, _sum: { monto: new Prisma.Decimal('300.00') } },
      ]);

      const result = await service.creditoDisponible(1);

      expect(result).toEqual([
        {
          returnId: 9,
          numero: 100,
          creditoDisponible: new Prisma.Decimal('300.00'),
        },
      ]);
      expect(prisma.returnPayment.groupBy).toHaveBeenCalledWith({
        by: ['returnId'],
        where: { returnId: { in: [10, 9] }, metodo: 'CREDITO_DEVOLUCION' },
        _sum: { monto: true },
      });
    });
  });
});
