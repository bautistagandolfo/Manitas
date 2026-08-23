import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface ProductResponseBody {
  id: number;
  nombre: string;
  descripcion: string | null;
  brandId: number | null;
  categoryId: number | null;
  activo: boolean;
  variants?: unknown[];
}

interface PaginatedProducts {
  items: ProductResponseBody[];
  itemCount: number;
  page: number;
  pageSize: number;
}

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('Products (integration)', () => {
  let app: INestApplication<App>;
  let authCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  let brandId: number;
  let categoryId: number;

  function authed(req: request.Test): request.Test {
    return req.set('Cookie', authCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const passwordHash = await argon2.hash('password123');
    const user = await prisma.user.create({
      data: {
        email: 'products-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(user.id);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: user.email, password: 'password123' })
      .expect(200);
    authCookie = extractCookie(login.headers['set-cookie']);

    const seller = await prisma.user.create({
      data: {
        email: 'products-test-seller@manitas.local',
        passwordHash,
        nombre: 'Seller de prueba',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    createdUserIds.push(seller.id);

    const sellerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: seller.email, password: 'password123' })
      .expect(200);
    sellerCookie = extractCookie(sellerLogin.headers['set-cookie']);

    const brand = await prisma.brand.create({
      data: { nombre: 'Marca Products Test' },
    });
    brandId = brand.id;

    const category = await prisma.category.create({
      data: { nombre: 'Categoría Products Test' },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    if (createdVariantIds.length > 0) {
      // FK a products con ON DELETE RESTRICT: hay que borrar las variantes
      // antes que sus productos.
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
    await prisma.brand.delete({ where: { id: brandId } });
    await prisma.category.delete({ where: { id: categoryId } });
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('GET /products sin sesión da 401', async () => {
    await request(app.getHttpServer()).get('/products').expect(401);
  });

  it('POST crea un producto y GET/:id lo trae con `variants: []`', async () => {
    const created = await authed(request(app.getHttpServer()).post('/products'))
      .send({
        nombre: 'Remera Products Test',
        descripcion: 'De algodón',
        brandId,
        categoryId,
      })
      .expect(201);
    const id = (created.body as ProductResponseBody).id;
    createdProductIds.push(id);

    expect(created.body).toMatchObject({
      nombre: 'Remera Products Test',
      descripcion: 'De algodón',
      brandId,
      categoryId,
      activo: true,
    });

    const fetched = await authed(
      request(app.getHttpServer()).get(`/products/${id}`),
    ).expect(200);
    expect((fetched.body as ProductResponseBody).variants).toEqual([]);
  });

  it('RN-3: GET /products/:id oculta costoActual de las variantes para SELLER, lo muestra para OWNER', async () => {
    const product = await authed(request(app.getHttpServer()).post('/products'))
      .send({ nombre: 'Producto Con Variante RN-3 Test' })
      .expect(201);
    const productId = (product.body as ProductResponseBody).id;
    createdProductIds.push(productId);

    const variant = await authed(
      request(app.getHttpServer()).post(`/products/${productId}/variants`),
    )
      .send({ sku: 'RN3-SKU-TEST', precioVenta: '19.99', costoActual: '9.50' })
      .expect(201);
    createdVariantIds.push((variant.body as { id: number }).id);

    const asOwner = await authed(
      request(app.getHttpServer()).get(`/products/${productId}`),
    ).expect(200);
    const ownerVariants = (asOwner.body as ProductResponseBody).variants as {
      costoActual?: string;
      precioVenta: string;
    }[];
    // decimal.js serializa en su forma canónica, no rellena a 2 decimales
    // (Prisma.Decimal('9.50').toString() da "9.5", no "9.50").
    expect(ownerVariants[0].costoActual).toBe('9.5');
    expect(ownerVariants[0].precioVenta).toBe('19.99');

    const asSeller = await sold(
      request(app.getHttpServer()).get(`/products/${productId}`),
    ).expect(200);
    const sellerVariants = (asSeller.body as ProductResponseBody).variants as {
      costoActual?: string;
      precioVenta: string;
    }[];
    expect(sellerVariants[0].costoActual).toBeUndefined();
    expect(sellerVariants[0].precioVenta).toBe('19.99');
  });

  it('POST sin marca ni categoría también es válido (ambas son opcionales)', async () => {
    const created = await authed(request(app.getHttpServer()).post('/products'))
      .send({ nombre: 'Producto Sin Marca Test' })
      .expect(201);
    createdProductIds.push((created.body as ProductResponseBody).id);
  });

  it('POST con brandId inexistente da 400, no 500', async () => {
    await authed(request(app.getHttpServer()).post('/products'))
      .send({ nombre: 'Producto FK Inválida Test', brandId: 999999 })
      .expect(400);
  });

  it('mass-assignment: activo/id forzados en el body se rechazan enteros (400)', async () => {
    await authed(request(app.getHttpServer()).post('/products'))
      .send({ nombre: 'Mass Assignment Test', activo: false, id: 999999 })
      .expect(400);
  });

  it('GET /products/:id inexistente da 404', async () => {
    await authed(request(app.getHttpServer()).get('/products/999999')).expect(
      404,
    );
  });

  it('PATCH sobre un id inexistente da 404', async () => {
    await authed(request(app.getHttpServer()).patch('/products/999999'))
      .send({ nombre: 'Nadie' })
      .expect(404);
  });

  it('PATCH actualiza y permite baja lógica', async () => {
    const created = await authed(request(app.getHttpServer()).post('/products'))
      .send({ nombre: 'Producto A Dar De Baja Test' })
      .expect(201);
    const id = (created.body as ProductResponseBody).id;
    createdProductIds.push(id);

    const updated = await authed(
      request(app.getHttpServer()).patch(`/products/${id}`),
    )
      .send({ activo: false })
      .expect(200);
    expect((updated.body as ProductResponseBody).activo).toBe(false);
  });

  describe('paginación y filtros', () => {
    beforeAll(async () => {
      const nombres = [
        'Paginación Test 1',
        'Paginación Test 2',
        'Paginación Test 3',
      ];
      for (const nombre of nombres) {
        const product = await prisma.product.create({
          data: { nombre, brandId, categoryId },
        });
        createdProductIds.push(product.id);
      }
    });

    it('respeta pageSize y devuelve el total real, no solo el de la página', async () => {
      const response = await authed(
        request(app.getHttpServer()).get(
          `/products?brandId=${brandId}&pageSize=2&page=1`,
        ),
      ).expect(200);
      const body = response.body as PaginatedProducts;

      expect(body.items.length).toBe(2);
      expect(body.itemCount).toBeGreaterThanOrEqual(3);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(2);
    });

    it('filtra por categoryId y activo', async () => {
      const response = await authed(
        request(app.getHttpServer()).get(
          `/products?categoryId=${categoryId}&activo=true`,
        ),
      ).expect(200);
      const body = response.body as PaginatedProducts;

      expect(body.items.length).toBeGreaterThan(0);
      for (const item of body.items) {
        expect(item.categoryId).toBe(categoryId);
        expect(item.activo).toBe(true);
      }
    });

    it('pageSize fuera de rango (> 100) da 400', async () => {
      await authed(
        request(app.getHttpServer()).get('/products?pageSize=1000'),
      ).expect(400);
    });
  });
});
