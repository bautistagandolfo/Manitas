import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { Prisma, PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface VariantSearchItem {
  id: number;
  sku: string;
  barcode: string | null;
  precioVenta: string;
  costoActual?: string;
  activo: boolean;
  product: { id: number; nombre: string };
}

interface PaginatedSearch {
  items: VariantSearchItem[];
  itemCount: number;
  page: number;
  pageSize: number;
}

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('GET /variants/search (integration, T2.7)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  async function createVariant(
    productNombre: string,
    sku: string,
    barcode: string | null,
    opts: { activo?: boolean; productoActivo?: boolean } = {},
  ): Promise<number> {
    const product = await prisma.product.create({
      data: {
        nombre: `${productNombre} ${suffix}`,
        activo: opts.productoActivo ?? true,
      },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `${sku}-${suffix}`,
        barcode: barcode ? `${barcode}-${suffix}` : null,
        precioVenta: new Prisma.Decimal('99.00'),
        costoActual: new Prisma.Decimal('40.00'),
        stockActual: 0,
        activo: opts.activo ?? true,
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
        email: `variants-search-test-owner-${suffix}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `variants-search-test-seller-${suffix}@manitas.local`,
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
    await request(app.getHttpServer()).get('/variants/search').expect(401);
  });

  it('SELLER puede buscar (no está en la lista de exclusiones de §5.1)', async () => {
    await createVariant('Campera Buscador', 'CMP', 'BARCMP');

    const response = await sold(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(`Campera Buscador ${suffix}`)}`,
      ),
    ).expect(200);
    const body = response.body as PaginatedSearch;
    expect(body.items.length).toBeGreaterThan(0);
  });

  it('RN-3: SELLER no ve costoActual, OWNER sí', async () => {
    await createVariant('Pantalon Buscador', 'PNT', 'BARPNT');
    const q = `Pantalon Buscador ${suffix}`;

    const asSeller = await sold(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(q)}`,
      ),
    ).expect(200);
    const sellerBody = asSeller.body as PaginatedSearch;
    expect(sellerBody.items[0].costoActual).toBeUndefined();

    const asOwner = await owned(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(q)}`,
      ),
    ).expect(200);
    const ownerBody = asOwner.body as PaginatedSearch;
    expect(ownerBody.items[0].costoActual).toBe('40');
  });

  it('RN-11: encuentra por nombre de producto (parcial)', async () => {
    await createVariant('Remera Manga Larga', 'RML', 'BARRML');

    const response = await owned(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(`Manga Larga ${suffix}`)}`,
      ),
    ).expect(200);
    const body = response.body as PaginatedSearch;
    expect(body.items.length).toBe(1);
  });

  it('RN-11: encuentra por SKU exacto (simula un lector de código de barras)', async () => {
    const variantId = await createVariant(
      'Buzo Buscador',
      'BUZ-UNICO',
      'BARBUZ',
    );

    const response = await owned(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(`BUZ-UNICO-${suffix}`)}`,
      ),
    ).expect(200);
    const body = response.body as PaginatedSearch;
    expect(body.items.map((i) => i.id)).toContain(variantId);
  });

  it('RN-11: encuentra por barcode exacto', async () => {
    const variantId = await createVariant(
      'Campera Buscador Barcode',
      'CMPB',
      'BARCODE-UNICO',
    );

    const response = await owned(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(`BARCODE-UNICO-${suffix}`)}`,
      ),
    ).expect(200);
    const body = response.body as PaginatedSearch;
    expect(body.items.map((i) => i.id)).toContain(variantId);
  });

  it('código de barras que no existe: lista vacía, no 404 (edge case de la spec)', async () => {
    const response = await owned(
      request(app.getHttpServer()).get(
        '/variants/search?q=CODIGO-QUE-NO-EXISTE-EN-NINGUN-LADO-999999',
      ),
    ).expect(200);
    const body = response.body as PaginatedSearch;
    expect(body.items).toEqual([]);
    expect(body.itemCount).toBe(0);
  });

  it('RN-11: una variante dada de baja no aparece aunque su producto siga activo', async () => {
    await createVariant('Short Inactivo', 'SHI', 'BARSHI', { activo: false });

    const response = await owned(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(`Short Inactivo ${suffix}`)}`,
      ),
    ).expect(200);
    const body = response.body as PaginatedSearch;
    expect(body.items).toEqual([]);
  });

  it('RN-11: una variante activa no aparece si su producto está dado de baja', async () => {
    await createVariant('Gorra Producto Inactivo', 'GRR', 'BARGRR', {
      productoActivo: false,
    });

    const response = await owned(
      request(app.getHttpServer()).get(
        `/variants/search?q=${encodeURIComponent(`Gorra Producto Inactivo ${suffix}`)}`,
      ),
    ).expect(200);
    const body = response.body as PaginatedSearch;
    expect(body.items).toEqual([]);
  });

  it('pageSize fuera de rango (> 100) da 400', async () => {
    await owned(
      request(app.getHttpServer()).get('/variants/search?pageSize=1000'),
    ).expect(400);
  });
});
