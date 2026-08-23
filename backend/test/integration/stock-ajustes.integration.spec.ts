import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Prisma,
  PrismaClient,
  StockMovementTipo,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface VariantResponseBody {
  id: number;
  stockActual: number;
}

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('POST /stock/ajustes (integration, T2.6)', () => {
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

  async function createTestVariant(stockActual = 10): Promise<number> {
    const product = await prisma.product.create({
      data: { nombre: `Producto Ajuste Test ${Date.now()}-${Math.random()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `AJUSTE-TEST-${Date.now()}-${Math.random()}`,
        precioVenta: new Prisma.Decimal('50.00'),
        costoActual: new Prisma.Decimal('20.00'),
        stockActual: 0,
      },
    });
    createdVariantIds.push(variant.id);

    if (stockActual > 0) {
      await prisma.stockMovement.create({
        data: {
          variantId: variant.id,
          delta: stockActual,
          tipo: StockMovementTipo.ENTRADA,
          costoUnitario: new Prisma.Decimal('20.00'),
          userId: (await prisma.user.findFirstOrThrow()).id,
        },
      });
      await prisma.variant.update({
        where: { id: variant.id },
        data: { stockActual },
      });
    }

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
        email: 'stock-ajuste-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'stock-ajuste-test-seller@manitas.local',
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
      .post('/stock/ajustes')
      .send({ variantId, delta: 1, motivo: 'x' })
      .expect(401);
  });

  it('RN-5: SELLER da 403', async () => {
    const variantId = await createTestVariant();
    await sold(request(app.getHttpServer()).post('/stock/ajustes'))
      .send({ variantId, delta: 1, motivo: 'Intento de SELLER' })
      .expect(403);
  });

  it('sin motivo da 400', async () => {
    const variantId = await createTestVariant();
    await owned(request(app.getHttpServer()).post('/stock/ajustes'))
      .send({ variantId, delta: 1, motivo: '' })
      .expect(400);
  });

  it('sin variantId o delta da 400', async () => {
    await owned(request(app.getHttpServer()).post('/stock/ajustes'))
      .send({ motivo: 'Falta variantId y delta' })
      .expect(400);
  });

  it('mass-assignment: userId forzado en el body se rechaza entero (400)', async () => {
    const variantId = await createTestVariant();
    await owned(request(app.getHttpServer()).post('/stock/ajustes'))
      .send({ variantId, delta: 1, motivo: 'x', userId: 999999 })
      .expect(400);
  });

  it('variante inexistente da 404, no 500', async () => {
    await owned(request(app.getHttpServer()).post('/stock/ajustes'))
      .send({ variantId: 999999, delta: 1, motivo: 'No existe' })
      .expect(404);
  });

  it('un ajuste que dejaría stock negativo da 409 y no toca la base', async () => {
    const variantId = await createTestVariant(5);

    await owned(request(app.getHttpServer()).post('/stock/ajustes'))
      .send({ variantId, delta: -10, motivo: 'Intento inválido' })
      .expect(409);

    const variant = await prisma.variant.findUniqueOrThrow({
      where: { id: variantId },
    });
    expect(variant.stockActual).toBe(5);
  });

  it('OWNER ajusta el stock correctamente (delta positivo y negativo) y devuelve la variante actualizada', async () => {
    const variantId = await createTestVariant(10);

    const up = await owned(request(app.getHttpServer()).post('/stock/ajustes'))
      .send({ variantId, delta: 3, motivo: 'Aparecieron unidades' })
      .expect(201);
    expect((up.body as VariantResponseBody).stockActual).toBe(13);

    const down = await owned(
      request(app.getHttpServer()).post('/stock/ajustes'),
    )
      .send({ variantId, delta: -5, motivo: 'Rotura de mercadería' })
      .expect(201);
    expect((down.body as VariantResponseBody).stockActual).toBe(8);

    const movements = await prisma.stockMovement.count({
      where: { variantId, tipo: StockMovementTipo.AJUSTE },
    });
    expect(movements).toBe(2);
  });
});
