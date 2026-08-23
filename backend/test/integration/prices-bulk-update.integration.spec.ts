import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Prisma,
  PrismaClient,
  PriceHistoryOrigen,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface BulkPriceUpdateItemBody {
  variantId: number;
  sku: string;
  precioActual: string;
  precioResultante: string;
}

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('POST /prices/bulk-update/{preview,apply} (integration, T2.10, RN-9)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  let brandId: number;
  let otherBrandId: number;
  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdBrandIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  async function createTestVariant(
    precioVenta: string,
    productBrandId?: number,
  ): Promise<{ variantId: number; productId: number }> {
    const product = await prisma.product.create({
      data: {
        nombre: `Producto Bulk Test ${Date.now()}-${Math.random()}`,
        brandId: productBrandId,
      },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `BULK-TEST-${Date.now()}-${Math.random()}`,
        precioVenta: new Prisma.Decimal(precioVenta),
        costoActual: new Prisma.Decimal('1.00'),
      },
    });
    createdVariantIds.push(variant.id);
    return { variantId: variant.id, productId: product.id };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: 'bulk-price-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'bulk-price-test-seller@manitas.local',
        passwordHash,
        nombre: 'Seller de prueba',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    createdUserIds.push(seller.id);

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: 'password123' })
      .expect(200);
    ownerCookie = extractCookie(ownerLogin.headers['set-cookie']);

    const sellerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: seller.email, password: 'password123' })
      .expect(200);
    sellerCookie = extractCookie(sellerLogin.headers['set-cookie']);

    const brand = await prisma.brand.create({
      data: { nombre: `Marca Bulk Test ${Date.now()}` },
    });
    brandId = brand.id;
    createdBrandIds.push(brand.id);

    const otherBrand = await prisma.brand.create({
      data: { nombre: `Otra Marca Bulk Test ${Date.now()}` },
    });
    otherBrandId = otherBrand.id;
    createdBrandIds.push(otherBrand.id);
  });

  afterAll(async () => {
    if (createdVariantIds.length > 0) {
      await prisma.priceHistory.deleteMany({
        where: { variantId: { in: createdVariantIds } },
      });
      await prisma.variant.deleteMany({
        where: { id: { in: createdVariantIds } },
      });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
    }
    if (createdBrandIds.length > 0) {
      await prisma.brand.deleteMany({
        where: { id: { in: createdBrandIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('autorización (RN-9: Solo OWNER)', () => {
    it('preview: SELLER da 403', async () => {
      await sold(
        request(app.getHttpServer()).post('/prices/bulk-update/preview'),
      )
        .send({ filtro: {}, porcentaje: '10.00' })
        .expect(403);
    });

    it('apply: SELLER da 403', async () => {
      await sold(request(app.getHttpServer()).post('/prices/bulk-update/apply'))
        .send({ filtro: {}, porcentaje: '10.00' })
        .expect(403);
    });
  });

  describe('validación del DTO', () => {
    it('rechaza porcentaje con más de 2 decimales (400)', async () => {
      await owned(
        request(app.getHttpServer()).post('/prices/bulk-update/preview'),
      )
        .send({ filtro: {}, porcentaje: '10.999' })
        .expect(400);
    });

    it('mass-assignment: un campo no reconocido en el body se rechaza (400)', async () => {
      await owned(
        request(app.getHttpServer()).post('/prices/bulk-update/preview'),
      )
        .send({ filtro: {}, porcentaje: '10.00', extra: 'no-deberia-entrar' })
        .expect(400);
    });
  });

  it('preview no escribe nada: precioVenta y price_history quedan sin cambios', async () => {
    const { variantId } = await createTestVariant('100.00', brandId);

    const response = await owned(
      request(app.getHttpServer()).post('/prices/bulk-update/preview'),
    )
      .send({ filtro: { variantIds: [variantId] }, porcentaje: '10.00' })
      .expect(201);

    const body = response.body as BulkPriceUpdateItemBody[];
    expect(body).toEqual([
      {
        variantId,
        sku: expect.any(String) as string,
        precioActual: '100',
        precioResultante: '110',
      },
    ]);

    const variant = await prisma.variant.findUniqueOrThrow({
      where: { id: variantId },
    });
    expect(variant.precioVenta.toString()).toBe('100');

    const historyCount = await prisma.priceHistory.count({
      where: { variantId, origen: PriceHistoryOrigen.MASIVO },
    });
    expect(historyCount).toBe(0);
  });

  it('apply escribe el precio nuevo y una fila de price_history con origen MASIVO', async () => {
    const { variantId } = await createTestVariant('100.00', brandId);

    const response = await owned(
      request(app.getHttpServer()).post('/prices/bulk-update/apply'),
    )
      .send({ filtro: { variantIds: [variantId] }, porcentaje: '10.00' })
      .expect(201);

    const body = response.body as BulkPriceUpdateItemBody[];
    expect(body).toEqual([
      {
        variantId,
        sku: expect.any(String) as string,
        precioActual: '100',
        precioResultante: '110',
      },
    ]);

    const variant = await prisma.variant.findUniqueOrThrow({
      where: { id: variantId },
    });
    expect(variant.precioVenta.toString()).toBe('110');

    const history = await prisma.priceHistory.findFirst({
      where: { variantId, origen: PriceHistoryOrigen.MASIVO },
    });
    expect(history?.valorAnterior?.toString()).toBe('100');
    expect(history?.valorNuevo.toString()).toBe('110');
  });

  it('apply con porcentaje negativo aplica una rebaja', async () => {
    const { variantId } = await createTestVariant('100.00', brandId);

    const response = await owned(
      request(app.getHttpServer()).post('/prices/bulk-update/apply'),
    )
      .send({ filtro: { variantIds: [variantId] }, porcentaje: '-20.00' })
      .expect(201);

    expect(
      (response.body as BulkPriceUpdateItemBody[])[0].precioResultante,
    ).toBe('80');
  });

  it('filtro por brandId solo afecta las variantes de esa marca', async () => {
    const { variantId: enMarca } = await createTestVariant('50.00', brandId);
    const { variantId: enOtraMarca } = await createTestVariant(
      '50.00',
      otherBrandId,
    );

    await owned(request(app.getHttpServer()).post('/prices/bulk-update/apply'))
      .send({ filtro: { brandId }, porcentaje: '10.00' })
      .expect(201);

    const afectada = await prisma.variant.findUniqueOrThrow({
      where: { id: enMarca },
    });
    expect(afectada.precioVenta.toString()).toBe('55');

    const noAfectada = await prisma.variant.findUniqueOrThrow({
      where: { id: enOtraMarca },
    });
    expect(noAfectada.precioVenta.toString()).toBe('50');
  });

  it('si el porcentaje dejaría a alguna variante con precioVenta <= 0, da 400 y no aplica NADA (todo o nada)', async () => {
    const { variantId: sana } = await createTestVariant('100.00', brandId);
    const { variantId: critica } = await createTestVariant('5.00', brandId);

    await owned(request(app.getHttpServer()).post('/prices/bulk-update/apply'))
      .send({
        filtro: { variantIds: [sana, critica] },
        porcentaje: '-100.00',
      })
      .expect(400);

    const variantSana = await prisma.variant.findUniqueOrThrow({
      where: { id: sana },
    });
    expect(variantSana.precioVenta.toString()).toBe('100');

    const historyCount = await prisma.priceHistory.count({
      where: {
        variantId: { in: [sana, critica] },
        origen: PriceHistoryOrigen.MASIVO,
      },
    });
    expect(historyCount).toBe(0);
  });

  it('sin filtro que matchee nada (marca inexistente), devuelve una lista vacía sin error', async () => {
    const response = await owned(
      request(app.getHttpServer()).post('/prices/bulk-update/preview'),
    )
      .send({ filtro: { brandId: 999999 }, porcentaje: '10.00' })
      .expect(201);

    expect(response.body).toEqual([]);
  });
});
