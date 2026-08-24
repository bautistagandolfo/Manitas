import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PricesService } from './prices.service';
import { PrismaService } from '../../prisma/prisma.service';
import { BulkPriceUpdateDto } from './dto/bulk-price-update.dto';

interface FindManyCall {
  where?: {
    activo?: boolean;
    product?: { activo?: boolean; brandId?: number; categoryId?: number };
    id?: { in: number[] };
  };
}

interface PriceHistoryCreateCall {
  data: {
    variantId: number;
    campo: string;
    valorAnterior: Prisma.Decimal | null;
    valorNuevo: Prisma.Decimal;
    origen: string;
    userId: number;
  };
}

type MockTx = {
  variant: {
    findMany: jest.Mock<Promise<unknown[]>, [FindManyCall]>;
    update: jest.Mock;
  };
  priceHistory: {
    create: jest.Mock<unknown, [PriceHistoryCreateCall]>;
  };
};

type MockPrisma = {
  variant: { findMany: jest.Mock<Promise<unknown[]>, [FindManyCall]> };
  $transaction: jest.Mock;
};

function buildMockPrisma(): { prisma: MockPrisma; tx: MockTx } {
  const tx: MockTx = {
    variant: {
      findMany: jest.fn<Promise<unknown[]>, [FindManyCall]>(),
      update: jest.fn(),
    },
    priceHistory: { create: jest.fn<unknown, [PriceHistoryCreateCall]>() },
  };

  const prisma: MockPrisma = {
    variant: { findMany: jest.fn<Promise<unknown[]>, [FindManyCall]>() },
    $transaction: jest.fn((callback: (tx: MockTx) => unknown) => callback(tx)),
  };

  return { prisma, tx };
}

function updateDto(overrides: Partial<BulkPriceUpdateDto> = {}) {
  return Object.assign(
    new BulkPriceUpdateDto(),
    { filtro: {}, porcentaje: '10.00' },
    overrides,
  );
}

describe('PricesService (T2.10, RN-9)', () => {
  let service: PricesService;
  let prisma: MockPrisma;
  let tx: MockTx;

  beforeEach(() => {
    ({ prisma, tx } = buildMockPrisma());
    service = new PricesService(prisma as unknown as PrismaService);
  });

  describe('preview', () => {
    it('no escribe nada: no llama a $transaction', async () => {
      prisma.variant.findMany.mockResolvedValue([]);

      await service.preview(updateDto());

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('calcula precioResultante con un porcentaje positivo (aumento), redondeado a 2 decimales', async () => {
      prisma.variant.findMany.mockResolvedValue([
        { id: 1, sku: 'A', precioVenta: new Prisma.Decimal('100.00') },
      ]);

      const result = await service.preview(updateDto({ porcentaje: '10.00' }));

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ variantId: 1, sku: 'A' });
      expect(result[0].precioActual.toString()).toBe('100');
      expect(result[0].precioResultante.toString()).toBe('110');
    });

    it('acepta un porcentaje negativo (rebaja)', async () => {
      prisma.variant.findMany.mockResolvedValue([
        { id: 1, sku: 'A', precioVenta: new Prisma.Decimal('100.00') },
      ]);

      const result = await service.preview(updateDto({ porcentaje: '-20.00' }));

      expect(result[0].precioResultante.toString()).toBe('80');
    });

    it('rechaza con BadRequestException si el resultado deja precioVenta en 0 o negativo, identificando el SKU', async () => {
      prisma.variant.findMany.mockResolvedValue([
        { id: 1, sku: 'SKU-CRITICO', precioVenta: new Prisma.Decimal('10.00') },
      ]);

      await expect(
        service.preview(updateDto({ porcentaje: '-100.00' })),
      ).rejects.toThrow(/SKU-CRITICO/);
      await expect(
        service.preview(updateDto({ porcentaje: '-100.00' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('filtra por brandId/categoryId combinados con AND (sin variantIds), excluyendo inactivas', async () => {
      prisma.variant.findMany.mockResolvedValue([]);

      await service.preview(
        updateDto({ filtro: { brandId: 5, categoryId: 9 } }),
      );

      expect(prisma.variant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            activo: true,
            product: expect.objectContaining({
              activo: true,
              brandId: 5,
              categoryId: 9,
            }) as unknown,
          }) as unknown,
        }),
      );
    });

    // BLUEPRINT §6, edge case: selección manual explícita de ids se
    // respeta tal cual, incluidas variantes inactivas — "es una decisión
    // consciente de quien la hizo". brandId/categoryId se ignoran cuando
    // hay variantIds: RN-9 los describe como modos alternativos ("por
    // marca, categoría O selección manual"), no combinables.
    it('con variantIds explícito, ignora brandId/categoryId y NO filtra por activo (edge case BLUEPRINT §6)', async () => {
      prisma.variant.findMany.mockResolvedValue([]);

      await service.preview(
        updateDto({
          filtro: { brandId: 5, categoryId: 9, variantIds: [1, 2] },
        }),
      );

      expect(prisma.variant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: [1, 2] } },
        }),
      );
    });

    it('sin filtro, consulta todo el catálogo activo (RN-11/RN-12: mismo criterio que el buscador sin q)', async () => {
      prisma.variant.findMany.mockResolvedValue([]);

      await service.preview(updateDto({ filtro: {} }));

      const call = prisma.variant.findMany.mock.calls[0][0];
      expect(call.where?.id).toBeUndefined();
      expect(call.where?.activo).toBe(true);
      expect(call.where?.product?.activo).toBe(true);
    });
  });

  describe('apply', () => {
    it('escribe variant.update y priceHistory.create con origen MASIVO por cada variante, dentro de la misma transacción', async () => {
      tx.variant.findMany.mockResolvedValue([
        { id: 1, sku: 'A', precioVenta: new Prisma.Decimal('100.00') },
        { id: 2, sku: 'B', precioVenta: new Prisma.Decimal('50.00') },
      ]);

      const result = await service.apply(updateDto({ porcentaje: '10.00' }), 7);

      expect(tx.variant.update).toHaveBeenCalledTimes(2);
      expect(tx.variant.update).toHaveBeenNthCalledWith(1, {
        where: { id: 1 },
        data: { precioVenta: expect.anything() as unknown },
      });
      expect(tx.priceHistory.create).toHaveBeenCalledTimes(2);
      expect(tx.priceHistory.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({
          variantId: 1,
          campo: 'PRECIO_VENTA',
          origen: 'MASIVO',
          userId: 7,
        }) as unknown,
      });
      const firstCall = tx.priceHistory.create.mock.calls[0][0];
      expect(firstCall.data.valorAnterior?.toString()).toBe('100');
      expect(firstCall.data.valorNuevo.toString()).toBe('110');
      expect(result).toHaveLength(2);
    });

    it('sin variantes que matcheen el filtro, no escribe nada y devuelve la lista vacía', async () => {
      tx.variant.findMany.mockResolvedValue([]);

      const result = await service.apply(updateDto(), 7);

      expect(result).toEqual([]);
      expect(tx.variant.update).not.toHaveBeenCalled();
      expect(tx.priceHistory.create).not.toHaveBeenCalled();
    });

    it('si cualquier variante quedaría en precioVenta <= 0, no escribe NADA (todo o nada, no aplicación parcial)', async () => {
      tx.variant.findMany.mockResolvedValue([
        { id: 1, sku: 'A', precioVenta: new Prisma.Decimal('100.00') },
        { id: 2, sku: 'B-CRITICA', precioVenta: new Prisma.Decimal('5.00') },
      ]);

      await expect(
        service.apply(updateDto({ porcentaje: '-100.00' }), 7),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.variant.update).not.toHaveBeenCalled();
      expect(tx.priceHistory.create).not.toHaveBeenCalled();
    });
  });
});
