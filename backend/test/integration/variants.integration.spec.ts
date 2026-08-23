import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, PriceHistoryOrigen, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface VariantResponseBody {
  id: number;
  sku: string;
  barcode: string | null;
  precioVenta: string;
  costoActual?: string;
  activo: boolean;
}

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('Variants (integration)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdProductIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  // Cada variante "sin talle ni color" que se cree para un mismo producto
  // choca con la constraint UNIQUE NULLS NOT DISTINCT de
  // (product_id, size_id, color_id) — por eso cada caso que no prueba
  // justamente esa colisión necesita su propio producto.
  async function createTestProduct(): Promise<number> {
    const product = await prisma.product.create({
      data: { nombre: `Producto Variants Test ${Date.now()}-${Math.random()}` },
    });
    createdProductIds.push(product.id);
    return product.id;
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
        email: 'variants-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'variants-test-seller@manitas.local',
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
      // GET /variants/:id/price-history (T2.9) ejercita POST
      // /stock/entradas para generar una fila INGRESO_MERCADERIA — eso
      // deja también un stock_movement, que hay que limpiar antes de
      // poder borrar la variante (FK).
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

  describe('POST /products/:id/variants (AMB-11: OWNER-only)', () => {
    it('SELLER da 403', async () => {
      const productId = await createTestProduct();
      await sold(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'SELLER-NO-PUEDE',
          precioVenta: '10.00',
          costoActual: '5.00',
        })
        .expect(403);
    });

    it('OWNER crea la variante y deja price_history con origen ALTA para precio y costo', async () => {
      const productId = await createTestProduct();
      const response = await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-ALTA-TEST',
          barcode: 'BAR-ALTA-TEST',
          precioVenta: '29.99',
          costoActual: '15.00',
        })
        .expect(201);
      const id = (response.body as VariantResponseBody).id;
      createdVariantIds.push(id);

      // decimal.js serializa canónico, no rellena a 2 decimales: "15", no
      // "15.00" (a diferencia de "29.99", que ya no tiene ceros de sobra).
      expect(response.body).toMatchObject({
        sku: 'VAR-ALTA-TEST',
        barcode: 'BAR-ALTA-TEST',
        precioVenta: '29.99',
        costoActual: '15',
        activo: true,
        stockActual: 0,
      });

      const history = await prisma.priceHistory.findMany({
        where: { variantId: id },
        orderBy: { campo: 'asc' },
      });
      expect(history).toHaveLength(2);
      for (const row of history) {
        expect(row.origen).toBe(PriceHistoryOrigen.ALTA);
        expect(row.valorAnterior).toBeNull();
      }
    });

    it('rechaza un producto inexistente con 404', async () => {
      await owned(
        request(app.getHttpServer()).post('/products/999999/variants'),
      )
        .send({ sku: 'NO-EXISTE', precioVenta: '10.00', costoActual: '5.00' })
        .expect(404);
    });

    it('rechaza SKU duplicado con 409 (en productos distintos: el choque es por SKU, no por talle/color)', async () => {
      const productA = await createTestProduct();
      const productB = await createTestProduct();

      const first = await owned(
        request(app.getHttpServer()).post(`/products/${productA}/variants`),
      )
        .send({
          sku: 'VAR-DUP-TEST',
          precioVenta: '10.00',
          costoActual: '5.00',
        })
        .expect(201);
      createdVariantIds.push((first.body as VariantResponseBody).id);

      await owned(
        request(app.getHttpServer()).post(`/products/${productB}/variants`),
      )
        .send({
          sku: 'VAR-DUP-TEST',
          precioVenta: '12.00',
          costoActual: '6.00',
        })
        .expect(409);
    });

    it('rechaza precioVenta o costoActual en 0 o negativo con 400', async () => {
      const productId = await createTestProduct();
      await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-CERO-TEST',
          precioVenta: '0.00',
          costoActual: '5.00',
        })
        .expect(400);
    });

    it('rechaza más de 2 decimales con 400 (DTO, antes de tocar la base)', async () => {
      const productId = await createTestProduct();
      await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-DECIMAL-TEST',
          precioVenta: '10.999',
          costoActual: '5.00',
        })
        .expect(400);
    });

    it('rechaza sizeId/colorId inexistente con 400, no 500', async () => {
      const productId = await createTestProduct();
      await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-FK-TEST',
          precioVenta: '10.00',
          costoActual: '5.00',
          sizeId: 999999,
        })
        .expect(400);
    });

    it('mass-assignment: stockActual forzado en el body se rechaza entero (400)', async () => {
      const productId = await createTestProduct();
      await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-MASS-TEST',
          precioVenta: '10.00',
          costoActual: '5.00',
          stockActual: 999,
        })
        .expect(400);
    });
  });

  describe('GET /variants/:id (RN-3)', () => {
    let variantId: number;

    beforeAll(async () => {
      const productId = await createTestProduct();
      const created = await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-GET-TEST',
          precioVenta: '50.00',
          costoActual: '20.00',
        })
        .expect(201);
      variantId = (created.body as VariantResponseBody).id;
      createdVariantIds.push(variantId);
    });

    it('OWNER ve costoActual', async () => {
      const response = await owned(
        request(app.getHttpServer()).get(`/variants/${variantId}`),
      ).expect(200);
      // decimal.js: "20", no "20.00" (forma canónica, sin ceros de sobra).
      expect((response.body as VariantResponseBody).costoActual).toBe('20');
    });

    it('SELLER no ve costoActual', async () => {
      const response = await sold(
        request(app.getHttpServer()).get(`/variants/${variantId}`),
      ).expect(200);
      expect(
        (response.body as VariantResponseBody).costoActual,
      ).toBeUndefined();
      expect((response.body as VariantResponseBody).precioVenta).toBe('50');
    });

    it('id inexistente da 404', async () => {
      await owned(request(app.getHttpServer()).get('/variants/999999')).expect(
        404,
      );
    });
  });

  describe('PATCH /variants/:id (sku/barcode/activo — cualquier rol)', () => {
    let variantId: number;

    beforeAll(async () => {
      const productId = await createTestProduct();
      const created = await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-PATCH-TEST',
          precioVenta: '15.00',
          costoActual: '7.00',
        })
        .expect(201);
      variantId = (created.body as VariantResponseBody).id;
      createdVariantIds.push(variantId);
    });

    it('SELLER puede actualizar sku/barcode/activo', async () => {
      const response = await sold(
        request(app.getHttpServer()).patch(`/variants/${variantId}`),
      )
        .send({ barcode: 'BAR-PATCH-TEST' })
        .expect(200);
      expect((response.body as VariantResponseBody).barcode).toBe(
        'BAR-PATCH-TEST',
      );
    });

    it('rechaza precioVenta en este endpoint (400) — tiene su propia ruta', async () => {
      await owned(request(app.getHttpServer()).patch(`/variants/${variantId}`))
        .send({ precioVenta: '999.00' })
        .expect(400);
    });

    it('rechaza costoActual en este endpoint (400)', async () => {
      await owned(request(app.getHttpServer()).patch(`/variants/${variantId}`))
        .send({ costoActual: '1.00' })
        .expect(400);
    });

    it('id inexistente da 404', async () => {
      await owned(request(app.getHttpServer()).patch('/variants/999999'))
        .send({ activo: false })
        .expect(404);
    });
  });

  describe('PATCH /variants/:id/price (AMB-11: OWNER-only)', () => {
    let variantId: number;

    beforeAll(async () => {
      const productId = await createTestProduct();
      const created = await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-PRICE-TEST',
          precioVenta: '40.00',
          costoActual: '18.00',
        })
        .expect(201);
      variantId = (created.body as VariantResponseBody).id;
      createdVariantIds.push(variantId);
    });

    it('SELLER da 403', async () => {
      await sold(
        request(app.getHttpServer()).patch(`/variants/${variantId}/price`),
      )
        .send({ precioVenta: '45.00' })
        .expect(403);
    });

    it('OWNER actualiza el precio y deja price_history con origen MANUAL', async () => {
      const response = await owned(
        request(app.getHttpServer()).patch(`/variants/${variantId}/price`),
      )
        .send({ precioVenta: '45.00' })
        .expect(200);
      expect((response.body as VariantResponseBody).precioVenta).toBe('45');

      const history = await prisma.priceHistory.findFirst({
        where: { variantId, origen: PriceHistoryOrigen.MANUAL },
      });
      expect(history?.valorAnterior?.toString()).toBe('40');
      expect(history?.valorNuevo.toString()).toBe('45');
    });

    it('rechaza 0 o negativo con 400', async () => {
      await owned(
        request(app.getHttpServer()).patch(`/variants/${variantId}/price`),
      )
        .send({ precioVenta: '0.00' })
        .expect(400);
    });
  });

  describe('GET /variants/:id/price-history (T2.9, AD-16, RN-3)', () => {
    let variantId: number;

    beforeAll(async () => {
      const productId = await createTestProduct();
      const created = await owned(
        request(app.getHttpServer()).post(`/products/${productId}/variants`),
      )
        .send({
          sku: 'VAR-HISTORY-TEST',
          precioVenta: '30.00',
          costoActual: '12.00',
        })
        .expect(201);
      variantId = (created.body as VariantResponseBody).id;
      createdVariantIds.push(variantId);

      // ALTA (precio + costo) ya quedó al crear la variante. Se suma un
      // cambio MANUAL de precio y un ingreso de mercadería (costo) para
      // tener las 4 filas esperadas: ALTA x2, MANUAL, INGRESO_MERCADERIA.
      await owned(
        request(app.getHttpServer()).patch(`/variants/${variantId}/price`),
      )
        .send({ precioVenta: '35.00' })
        .expect(200);

      await owned(request(app.getHttpServer()).post('/stock/entradas'))
        .send({ variantId, cantidad: 5, costoUnitario: '14.00' })
        .expect(201);
    });

    it('SELLER da 403 (RN-3: incluye costo)', async () => {
      await sold(
        request(app.getHttpServer()).get(
          `/variants/${variantId}/price-history`,
        ),
      ).expect(403);
    });

    it('OWNER ve las 4 filas paginadas, la más reciente primero', async () => {
      const response = await owned(
        request(app.getHttpServer()).get(
          `/variants/${variantId}/price-history`,
        ),
      ).expect(200);

      const body = response.body as {
        items: { campo: string; origen: string }[];
        itemCount: number;
        page: number;
        pageSize: number;
      };

      expect(body.itemCount).toBe(4);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(20);
      expect(body.items).toHaveLength(4);
      // Las dos últimas escrituras tienen orden estrictamente determinado
      // (MANUAL antes que INGRESO_MERCADERIA, ambas después de ALTA) — las
      // dos filas de ALTA se escriben en la misma transacción (createMany)
      // y pueden compartir created_at, así que no se les exige un orden
      // relativo entre sí.
      expect(body.items[0]).toMatchObject({
        campo: 'COSTO',
        origen: 'INGRESO_MERCADERIA',
      });
      expect(body.items[1]).toMatchObject({
        campo: 'PRECIO_VENTA',
        origen: 'MANUAL',
      });
      const origenesRestantes = body.items.slice(2).map((i) => i.origen);
      expect(origenesRestantes).toEqual(['ALTA', 'ALTA']);
    });

    it('respeta pageSize (paginado)', async () => {
      const response = await owned(
        request(app.getHttpServer())
          .get(`/variants/${variantId}/price-history`)
          .query({ page: 1, pageSize: 2 }),
      ).expect(200);

      const body = response.body as { items: unknown[]; itemCount: number };
      expect(body.items).toHaveLength(2);
      expect(body.itemCount).toBe(4);
    });

    it('variante inexistente da 404', async () => {
      await owned(
        request(app.getHttpServer()).get('/variants/999999/price-history'),
      ).expect(404);
    });
  });

  it('UNIQUE NULLS NOT DISTINCT: dos variantes sin talle ni color para el mismo producto dan 409 en la segunda', async () => {
    const productId = await createTestProduct();

    const first = await owned(
      request(app.getHttpServer()).post(`/products/${productId}/variants`),
    )
      .send({ sku: 'VAR-NULLS-1', precioVenta: '10.00', costoActual: '5.00' })
      .expect(201);
    createdVariantIds.push((first.body as VariantResponseBody).id);

    await owned(
      request(app.getHttpServer()).post(`/products/${productId}/variants`),
    )
      .send({ sku: 'VAR-NULLS-2', precioVenta: '10.00', costoActual: '5.00' })
      .expect(409);
  });
});
