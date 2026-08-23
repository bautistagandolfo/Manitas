import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ProductsService } from './products.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ProductQueryDto } from './dto/product-query.dto';

type MockPrisma = {
  product: {
    create: jest.Mock;
    findMany: jest.Mock;
    findUnique: jest.Mock;
    update: jest.Mock;
    count: jest.Mock;
  };
};

function buildMockPrisma(): MockPrisma {
  return {
    product: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
  };
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

function query(overrides: Partial<ProductQueryDto> = {}): ProductQueryDto {
  return Object.assign(
    new ProductQueryDto(),
    { page: 1, pageSize: 20 },
    overrides,
  );
}

describe('ProductsService', () => {
  let prisma: MockPrisma;
  let service: ProductsService;

  beforeEach(() => {
    prisma = buildMockPrisma();
    service = new ProductsService(prisma as unknown as PrismaService);
  });

  describe('findAll', () => {
    it('pagina en el servidor y devuelve items/total/page/pageSize', async () => {
      prisma.product.findMany.mockResolvedValue([{ id: 1, nombre: 'Remera' }]);
      prisma.product.count.mockResolvedValue(1);

      const result = await service.findAll(query({ page: 2, pageSize: 10 }));

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 10, take: 10 }),
      );
      expect(result).toEqual({
        items: [{ id: 1, nombre: 'Remera' }],
        itemCount: 1,
        page: 2,
        pageSize: 10,
      });
    });

    it('filtra por marca, categoría y activo cuando se pasan', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll(query({ brandId: 5, categoryId: 7, activo: true }));

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { brandId: 5, categoryId: 7, activo: true },
        }),
      );
    });

    it('sin filtros no restringe el where', async () => {
      prisma.product.findMany.mockResolvedValue([]);
      prisma.product.count.mockResolvedValue(0);

      await service.findAll(query());

      expect(prisma.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });
  });

  describe('findOne', () => {
    it('incluye las variantes', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: 1, variants: [] });

      await service.findOne(1, true);

      expect(prisma.product.findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        include: { variants: true },
      });
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(service.findOne(999, true)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('RN-3: oculta costoActual de las variantes si quien pregunta no es OWNER', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 1,
        variants: [{ id: 10, costoActual: '5.00', precioVenta: '10.00' }],
      });

      const result = await service.findOne(1, false);

      expect(
        (result.variants[0] as { costoActual?: string }).costoActual,
      ).toBeUndefined();
      expect(result.variants[0].precioVenta).toBe('10.00');
    });

    it('RN-3: muestra costoActual si quien pregunta es OWNER', async () => {
      prisma.product.findUnique.mockResolvedValue({
        id: 1,
        variants: [{ id: 10, costoActual: '5.00', precioVenta: '10.00' }],
      });

      const result = await service.findOne(1, true);

      expect((result.variants[0] as { costoActual?: string }).costoActual).toBe(
        '5.00',
      );
    });
  });

  describe('create', () => {
    it('crea un producto', async () => {
      prisma.product.create.mockResolvedValue({ id: 1, nombre: 'Remera' });

      const result = await service.create({ nombre: 'Remera' });

      expect(result).toEqual({ id: 1, nombre: 'Remera' });
    });

    it('traduce una FK inválida (marca/categoría inexistente) a BadRequestException', async () => {
      prisma.product.create.mockRejectedValue(prismaForeignKeyViolation());

      await expect(
        service.create({ nombre: 'Remera', brandId: 999999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('update', () => {
    it('actualiza un producto', async () => {
      prisma.product.update.mockResolvedValue({ id: 1, nombre: 'Campera' });

      const result = await service.update(1, { nombre: 'Campera' });

      expect(result).toEqual({ id: 1, nombre: 'Campera' });
    });

    it('traduce un id inexistente a NotFoundException', async () => {
      prisma.product.update.mockRejectedValue(prismaRecordNotFound());

      await expect(service.update(999, { nombre: 'X' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('traduce una FK inválida a BadRequestException', async () => {
      prisma.product.update.mockRejectedValue(prismaForeignKeyViolation());

      await expect(
        service.update(1, { categoryId: 999999 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
