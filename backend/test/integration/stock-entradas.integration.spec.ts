import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Prisma,
  PrismaClient,
  PriceHistoryOrigen,
  StockMovementTipo,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface VariantResponseBody {
  id: number;
  stockActual: number;
  costoActual: string;
}

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('POST /stock/entradas (integration, T2.5)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  async function createTestVariant(
    costoActualInicial = '5.00',
  ): Promise<number> {
    const product = await prisma.product.create({
      data: { nombre: `Producto Entrada Test ${Date.now()}-${Math.random()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `ENTRADA-TEST-${Date.now()}-${Math.random()}`,
        precioVenta: new Prisma.Decimal('99.00'),
        costoActual: new Prisma.Decimal(costoActualInicial),
        stockActual: 0,
      },
    });
    createdVariantIds.push(variant.id);
    return variant.id;
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
        email: 'stock-entrada-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'stock-entrada-test-seller@manitas.local',
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
  });

  afterAll(async () => {
    if (createdVariantIds.length > 0) {
      await prisma.stockMovement.deleteMany({
        where: { variantId: { in: createdVariantIds } },
      });
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
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('sin sesión da 401', async () => {
    const variantId = await createTestVariant();
    await request(app.getHttpServer())
      .post('/stock/entradas')
      .send({ variantId, cantidad: 5, costoUnitario: '10.00' })
      .expect(401);
  });

  it('AMB-11: SELLER da 403', async () => {
    const variantId = await createTestVariant();
    await sold(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId, cantidad: 5, costoUnitario: '10.00' })
      .expect(403);
  });

  it('cantidad 0 o negativa da 400', async () => {
    const variantId = await createTestVariant();
    await owned(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId, cantidad: 0, costoUnitario: '10.00' })
      .expect(400);
    await owned(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId, cantidad: -3, costoUnitario: '10.00' })
      .expect(400);
  });

  it('costoUnitario 0 o negativo da 400', async () => {
    const variantId = await createTestVariant();
    await owned(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId, cantidad: 5, costoUnitario: '0.00' })
      .expect(400);
  });

  it('más de 2 decimales en costoUnitario da 400 (DTO, antes de tocar la base)', async () => {
    const variantId = await createTestVariant();
    await owned(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId, cantidad: 5, costoUnitario: '10.999' })
      .expect(400);
  });

  it('mass-assignment: userId forzado en el body se rechaza entero (400)', async () => {
    const variantId = await createTestVariant();
    await owned(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId, cantidad: 5, costoUnitario: '10.00', userId: 999999 })
      .expect(400);
  });

  it('variante inexistente da 404, no 500', async () => {
    await owned(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId: 999999, cantidad: 5, costoUnitario: '10.00' })
      .expect(404);
  });

  it('OWNER ingresa mercadería: suma stock, actualiza costo_actual, deja price_history con origen INGRESO_MERCADERIA', async () => {
    const variantId = await createTestVariant('3.00');

    const response = await owned(
      request(app.getHttpServer()).post('/stock/entradas'),
    )
      .send({ variantId, cantidad: 12, costoUnitario: '7.50' })
      .expect(201);

    const body = response.body as VariantResponseBody;
    expect(body.stockActual).toBe(12);
    expect(body.costoActual).toBe('7.5');

    const movement = await prisma.stockMovement.findFirst({
      where: { variantId, tipo: StockMovementTipo.ENTRADA },
    });
    expect(movement).toMatchObject({ delta: 12 });
    expect(movement?.costoUnitario?.toString()).toBe('7.5');

    const history = await prisma.priceHistory.findFirst({
      where: { variantId, origen: PriceHistoryOrigen.INGRESO_MERCADERIA },
    });
    expect(history?.valorAnterior?.toString()).toBe('3');
    expect(history?.valorNuevo.toString()).toBe('7.5');
  });

  it('dos entradas sucesivas suman el stock y actualizan el costo al último valor ingresado (AD-6)', async () => {
    const variantId = await createTestVariant('1.00');

    await owned(request(app.getHttpServer()).post('/stock/entradas'))
      .send({ variantId, cantidad: 5, costoUnitario: '8.00' })
      .expect(201);
    const second = await owned(
      request(app.getHttpServer()).post('/stock/entradas'),
    )
      .send({ variantId, cantidad: 3, costoUnitario: '9.00' })
      .expect(201);

    const body = second.body as VariantResponseBody;
    expect(body.stockActual).toBe(8);
    expect(body.costoActual).toBe('9');

    const movements = await prisma.stockMovement.count({
      where: { variantId, tipo: StockMovementTipo.ENTRADA },
    });
    expect(movements).toBe(2);
  });
});
