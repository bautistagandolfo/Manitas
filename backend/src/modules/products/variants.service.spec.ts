import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { VariantsService } from './variants.service';
import { PrismaService } from '../../prisma/prisma.service';
import { VariantSearchQueryDto } from './dto/variant-search-query.dto';

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
  variant: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock };
  priceHistory: {
    createMany: jest.Mock;
    create: jest.Mock<unknown, [PriceHistoryCreateCall]>;
  };
};

interface FindManyCall {
  where?: { OR?: unknown[] };
  skip?: number;
  take?: number;
}

type MockPrisma = {
  product: { findUnique: jest.Mock };
  variant: {
    findUnique: jest.Mock;
    update: jest.Mock;
    findMany: jest.Mock<Promise<unknown[]>, [FindManyCall]>;
    count: jest.Mock;
  };
  $transaction: jest.Mock;
};

function buildMockPrisma(): { prisma: MockPrisma; tx: MockTx } {
  const tx: MockTx = {
    variant: {
      create: jest.fn(),
      update: jest.fn(),
      findUnique: jest.fn(),
    },
    priceHistory: {
      createMany: jest.fn(),
      create: jest.fn<unknown, [PriceHistoryCreateCall]>(),
    },
  };

  const prisma: MockPrisma = {
    product: { findUnique: jest.fn() },
    variant: {
      findUnique: jest.fn(),
      update: jest.fn(),
      findMany: jest.fn<Promise<unknown[]>, [FindManyCall]>(),
      count: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: MockTx) => unknown) => callback(tx)),
  };

  return { prisma, tx };
}

function searchQuery(
  overrides: Partial<VariantSearchQueryDto> = {},
): VariantSearchQueryDto {
  return Object.assign(
    new VariantSearchQueryDto(),
    { page: 1, pageSize: 20 },
    overrides,
  );
}

function prismaUniqueViolation(
  target: string,
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target },
  });
}

function prismaForeignKeyViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Foreign key constraint failed',
    { code: 'P2003', clientVersion: '6.19.3' },
  );
}

function prismaRecordNotFound(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Record not found', {
    code: 'P2025',
    clientVersion: '6.19.3',
  });
}

describe('VariantsService', () => {
  let prisma: MockPrisma;
  let tx: MockTx;
  let service: VariantsService;

  beforeEach(() => {
    const built = buildMockPrisma();
    prisma = built.prisma;
    tx = built.tx;
    service = new VariantsService(prisma as unknown as PrismaService);
  });

  describe('search', () => {
    it('filtra por activo=true y product.activo=true siempre, con o sin q', async () => {
      prisma.variant.findMany.mockResolvedValue([]);
      prisma.variant.count.mockResolvedValue(0);

      await service.search(searchQuery(), true);

      expect(prisma.variant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { activo: true, product: { activo: true } },
        }) as unknown,
      );
    });

    it('con q, busca por nombre de producto, sku o barcode (OR, insensible a mayúsculas)', async () => {
      prisma.variant.findMany.mockResolvedValue([]);
      prisma.variant.count.mockResolvedValue(0);

      await service.search(searchQuery({ q: 'campera' }), true);

      const call = prisma.variant.findMany.mock.calls[0][0];
      expect(call.where?.OR).toEqual([
        { sku: { contains: 'campera', mode: 'insensitive' } },
        { barcode: { contains: 'campera', mode: 'insensitive' } },
        { product: { nombre: { contains: 'campera', mode: 'insensitive' } } },
      ]);
    });

    it('oculta costoActual de cada resultado si no es OWNER', async () => {
      prisma.variant.findMany.mockResolvedValue([
        {
          id: 1,
          sku: 'X',
          barcode: null,
          precioVenta: new Prisma.Decimal('10.00'),
          costoActual: new Prisma.Decimal('5.00'),
          stockActual: 3,
          activo: true,
          product: { id: 1, nombre: 'Remera' },
          size: null,
          color: null,
        },
      ]);
      prisma.variant.count.mockResolvedValue(1);

      const result = await service.search(searchQuery(), false);

      expect(result.items[0].costoActual).toBeUndefined();
      expect(result.items[0].precioVenta.toString()).toBe('10');
      expect(result.items[0].product).toEqual({ id: 1, nombre: 'Remera' });
    });

    it('pagina en el servidor y devuelve itemCount/page/pageSize', async () => {
      prisma.variant.findMany.mockResolvedValue([]);
      prisma.variant.count.mockResolvedValue(45);

      const result = await service.search(
        searchQuery({ page: 2, pageSize: 10 }),
        true,
      );

      expect(prisma.variant.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }) as unknown,
      );
      expect(result).toMatchObject({
        itemCount: 45,
        page: 2,
        pageSize: 10,
      });
    });
  });

  describe('findOne', () => {
    it('oculta costoActual si no es OWNER', async () => {
      prisma.variant.findUnique.mockResolvedValue({
        id: 1,
        sku: 'X',
        precioVenta: new Prisma.Decimal('10.00'),
        costoActual: new Prisma.Decimal('5.00'),
      });

      const result = await service.findOne(1, false);

      expect(result.costoActual).toBeUndefined();
      expect(result.precioVenta.toString()).toBe('10');
    });

    it('muestra costoActual si es OWNER', async () => {
      prisma.variant.findUnique.mockResolvedValue({
        id: 1,
        sku: 'X',
        precioVenta: new Prisma.Decimal('10.00'),
        costoActual: new Prisma.Decimal('5.00'),
      });

      const result = await service.findOne(1, true);

      expect(result.costoActual?.toString()).toBe('5');
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.variant.findUnique.mockResolvedValue(null);

      await expect(service.findOne(999, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('create', () => {
    it('lanza NotFoundException si el producto no existe', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.create(
          1,
          { sku: 'X', precioVenta: '10.00', costoActual: '5.00' },
          1,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza precioVenta <= 0', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1 });

      await expect(
        service.create(
          1,
          { sku: 'X', precioVenta: '0.00', costoActual: '5.00' },
          1,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rechaza costoActual <= 0', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1 });

      await expect(
        service.create(
          1,
          { sku: 'X', precioVenta: '10.00', costoActual: '-1.00' },
          1,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('crea la variante y escribe 2 filas de price_history con origen ALTA, en la misma transacción', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1 });
      tx.variant.create.mockResolvedValue({
        id: 10,
        sku: 'X',
        precioVenta: new Prisma.Decimal('10.00'),
        costoActual: new Prisma.Decimal('5.00'),
      });

      await service.create(
        1,
        { sku: 'X', precioVenta: '10.00', costoActual: '5.00' },
        7,
      );

      expect(tx.priceHistory.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            variantId: 10,
            campo: 'PRECIO_VENTA',
            valorAnterior: null,
            origen: 'ALTA',
            userId: 7,
          }),
          expect.objectContaining({
            variantId: 10,
            campo: 'COSTO',
            valorAnterior: null,
            origen: 'ALTA',
            userId: 7,
          }),
        ],
      });
    });

    it('traduce SKU duplicado a ConflictException con mensaje específico', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1 });
      prisma.$transaction.mockRejectedValue(
        prismaUniqueViolation('variants_sku_key'),
      );

      await expect(
        service.create(
          1,
          { sku: 'X', precioVenta: '10.00', costoActual: '5.00' },
          1,
        ),
      ).rejects.toThrow(
        new ConflictException('Ya existe una variante con ese SKU'),
      );
    });

    it('traduce barcode duplicado a ConflictException con mensaje específico', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1 });
      prisma.$transaction.mockRejectedValue(
        prismaUniqueViolation('variants_barcode_key'),
      );

      await expect(
        service.create(
          1,
          { sku: 'X', precioVenta: '10.00', costoActual: '5.00' },
          1,
        ),
      ).rejects.toThrow(
        new ConflictException(
          'Ya existe una variante con ese código de barras',
        ),
      );
    });

    it('traduce la colisión de (product,size,color) a ConflictException', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1 });
      prisma.$transaction.mockRejectedValue(
        prismaUniqueViolation('variants_product_size_color_key'),
      );

      await expect(
        service.create(
          1,
          { sku: 'X', precioVenta: '10.00', costoActual: '5.00' },
          1,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('traduce una FK inválida (sizeId/colorId) a BadRequestException', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1 });
      prisma.$transaction.mockRejectedValue(prismaForeignKeyViolation());

      await expect(
        service.create(
          1,
          { sku: 'X', precioVenta: '10.00', costoActual: '5.00', sizeId: 999 },
          1,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('actualiza y oculta costoActual si no es OWNER', async () => {
      prisma.variant.update.mockResolvedValue({
        id: 1,
        sku: 'Y',
        precioVenta: new Prisma.Decimal('10.00'),
        costoActual: new Prisma.Decimal('5.00'),
      });

      const result = await service.update(1, { sku: 'Y' }, false);

      expect(result.costoActual).toBeUndefined();
    });

    it('traduce id inexistente a NotFoundException', async () => {
      prisma.variant.update.mockRejectedValue(prismaRecordNotFound());

      await expect(
        service.update(999, { sku: 'Y' }, true),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('traduce SKU duplicado a ConflictException', async () => {
      prisma.variant.update.mockRejectedValue(
        prismaUniqueViolation('variants_sku_key'),
      );

      await expect(
        service.update(1, { sku: 'Y' }, true),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('updatePrice', () => {
    it('lanza NotFoundException si la variante no existe', async () => {
      tx.variant.findUnique.mockResolvedValue(null);

      await expect(
        service.updatePrice(999, { precioVenta: '10.00' }, 1),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rechaza precioVenta <= 0', async () => {
      await expect(
        service.updatePrice(1, { precioVenta: '0.00' }, 1),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('actualiza el precio y escribe price_history con origen MANUAL y el valor anterior', async () => {
      tx.variant.findUnique.mockResolvedValue({
        id: 1,
        precioVenta: new Prisma.Decimal('10.00'),
      });
      tx.variant.update.mockResolvedValue({
        id: 1,
        precioVenta: new Prisma.Decimal('12.00'),
      });

      await service.updatePrice(1, { precioVenta: '12.00' }, 7);

      expect(tx.priceHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          variantId: 1,
          campo: 'PRECIO_VENTA',
          origen: 'MANUAL',
          userId: 7,
        }) as unknown,
      });
      const call = tx.priceHistory.create.mock.calls[0][0];
      expect(call.data.valorAnterior?.toString()).toBe('10');
      expect(call.data.valorNuevo.toString()).toBe('12');
    });
  });
});
