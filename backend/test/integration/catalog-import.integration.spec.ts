import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PrismaClient,
  PriceHistoryOrigen,
  StockMovementTipo,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface ImportRowResultBody {
  linea: number;
  estado: 'OK' | 'ERROR';
  mensaje?: string;
  sku?: string;
}

interface ImportResultBody {
  filasCount: number;
  exitosas: number;
  fallidas: number;
  filas: ImportRowResultBody[];
}

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

// T2.13 / AMB-12 (RESUELTA): importación de catálogo por CSV — plantilla
// propia (nombre,descripcion,marca,categoria,talle,color,sku,barcode,
// precio,costo,stock). OWNER-only. Cada fila en su propia transacción:
// una fila inválida no aborta el resto del archivo.
describe('POST /products/import (integration, T2.13, AMB-12)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdBrandIds: number[] = [];
  const createdCategoryIds: number[] = [];
  const createdSizeIds: number[] = [];
  const createdColorIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  // Registra en las base de datos de prueba lo que el import haya creado
  // (productos/marca/categoría/talle/color no se conocen de antemano —
  // el import los genera), para poder limpiarlos en afterAll.
  async function trackCreatedByName(nombreProducto: string): Promise<void> {
    const product = await prisma.product.findFirst({
      where: { nombre: nombreProducto },
      include: { variants: true },
    });
    if (!product) return;
    createdProductIds.push(product.id);
    createdVariantIds.push(...product.variants.map((v) => v.id));
  }

  async function trackReferenceData(
    nombre: string,
    table: 'brand' | 'category' | 'size' | 'color',
  ): Promise<void> {
    const row = await (
      prisma[table] as {
        findFirst: (args: unknown) => Promise<{ id: number } | null>;
      }
    ).findFirst({
      where: { nombre },
    });
    if (!row) return;
    if (table === 'brand') createdBrandIds.push(row.id);
    if (table === 'category') createdCategoryIds.push(row.id);
    if (table === 'size') createdSizeIds.push(row.id);
    if (table === 'color') createdColorIds.push(row.id);
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
        email: 'csv-import-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'csv-import-test-seller@manitas.local',
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
    if (createdSizeIds.length > 0) {
      await prisma.size.deleteMany({ where: { id: { in: createdSizeIds } } });
    }
    if (createdColorIds.length > 0) {
      await prisma.color.deleteMany({ where: { id: { in: createdColorIds } } });
    }
    if (createdBrandIds.length > 0) {
      await prisma.brand.deleteMany({ where: { id: { in: createdBrandIds } } });
    }
    if (createdCategoryIds.length > 0) {
      await prisma.category.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('SELLER da 403', async () => {
    await sold(request(app.getHttpServer()).post('/products/import'))
      .send({ csv: 'nombre,precio,costo,stock\nProducto,10.00,5.00,1\n' })
      .expect(403);
  });

  it('mass-assignment: un campo no reconocido en el body se rechaza (400)', async () => {
    await owned(request(app.getHttpServer()).post('/products/import'))
      .send({ csv: 'nombre,precio,costo,stock\n', extra: 'no-debería-entrar' })
      .expect(400);
  });

  it('encabezado sin columnas obligatorias da 400', async () => {
    await owned(request(app.getHttpServer()).post('/products/import'))
      .send({ csv: 'nombre,precio\nProducto,10.00\n' })
      .expect(400);
  });

  it('crea producto, marca, categoría, talle, color y variante nuevos desde cero, con stock_movements y price_history correctos', async () => {
    const marca = `Marca Import Test ${Date.now()}`;
    const categoria = `Categoría Import Test ${Date.now()}`;
    const talle = `TalleImport${Date.now()}`;
    const color = `ColorImport${Date.now()}`;
    const nombreProducto = `Producto Import Test ${Date.now()}`;
    const sku = `IMPORT-TEST-${Date.now()}`;

    const csv =
      'nombre,marca,categoria,talle,color,sku,precio,costo,stock\n' +
      `${nombreProducto},${marca},${categoria},${talle},${color},${sku},1500.00,700.00,8\n`;

    const response = await owned(
      request(app.getHttpServer()).post('/products/import'),
    )
      .send({ csv })
      .expect(201);

    const body = response.body as ImportResultBody;
    expect(body).toEqual({
      filasCount: 1,
      exitosas: 1,
      fallidas: 0,
      filas: [{ linea: 2, estado: 'OK', sku }],
    });

    await trackCreatedByName(nombreProducto);
    await trackReferenceData(marca, 'brand');
    await trackReferenceData(categoria, 'category');
    await trackReferenceData(talle, 'size');
    await trackReferenceData(color, 'color');

    const variant = await prisma.variant.findUnique({ where: { sku } });
    expect(variant).not.toBeNull();
    expect(variant?.stockActual).toBe(8);
    expect(variant?.precioVenta.toString()).toBe('1500');
    expect(variant?.costoActual.toString()).toBe('700');

    const movement = await prisma.stockMovement.findFirst({
      where: { variantId: variant?.id, tipo: StockMovementTipo.ENTRADA },
    });
    expect(movement).toMatchObject({ delta: 8 });

    const priceHistoryRows = await prisma.priceHistory.findMany({
      where: { variantId: variant?.id },
    });
    expect(priceHistoryRows).toHaveLength(2);
    expect(
      priceHistoryRows.find((r) => r.campo === 'PRECIO_VENTA')?.origen,
    ).toBe(PriceHistoryOrigen.ALTA);
    expect(priceHistoryRows.find((r) => r.campo === 'COSTO')?.origen).toBe(
      PriceHistoryOrigen.INGRESO_MERCADERIA,
    );

    const product = await prisma.product.findUnique({
      where: { id: variant!.productId },
    });
    expect(product?.nombre).toBe(nombreProducto);
  });

  it('reusa un producto existente por nombre (case-insensitive) para dos filas del mismo import', async () => {
    const nombreProducto = `Reusa Producto Test ${Date.now()}`;
    const sku1 = `REUSA-1-${Date.now()}`;
    const sku2 = `REUSA-2-${Date.now()}`;

    // Dos filas del MISMO producto necesitan distinguirse por talle o
    // color — si ninguna de las dos filas tuviera ninguno, la segunda
    // chocaría con la constraint UNIQUE NULLS NOT DISTINCT de
    // (product_id, size_id, color_id): dos variantes "sin talle ni
    // color" del mismo producto no pueden coexistir. Eso ya lo prueba
    // el test de "SKU duplicado" más abajo, con el mensaje de error
    // correcto — acá se prueba específicamente el reuso del producto.
    const talle1 = `TalleReusa1-${Date.now()}`;
    const talle2 = `TalleReusa2-${Date.now()}`;

    const csv =
      'nombre,talle,sku,precio,costo,stock\n' +
      `${nombreProducto.toUpperCase()},${talle1},${sku1},10.00,5.00,1\n` +
      `${nombreProducto.toLowerCase()},${talle2},${sku2},20.00,10.00,2\n`;

    const response = await owned(
      request(app.getHttpServer()).post('/products/import'),
    )
      .send({ csv })
      .expect(201);

    const body = response.body as ImportResultBody;
    await trackCreatedByName(nombreProducto.toUpperCase());
    await trackReferenceData(talle1, 'size');
    await trackReferenceData(talle2, 'size');

    expect(body.exitosas).toBe(2);

    const variant1 = await prisma.variant.findUnique({ where: { sku: sku1 } });
    const variant2 = await prisma.variant.findUnique({ where: { sku: sku2 } });
    expect(variant1?.productId).toBe(variant2?.productId);

    const productCount = await prisma.product.count({
      where: { nombre: { equals: nombreProducto, mode: 'insensitive' } },
    });
    expect(productCount).toBe(1);
  });

  it('genera el SKU automáticamente cuando la celda viene vacía', async () => {
    const nombreProducto = `Producto Sin SKU Test ${Date.now()}`;

    const csv =
      'nombre,precio,costo,stock\n' + `${nombreProducto},10.00,5.00,1\n`;

    const response = await owned(
      request(app.getHttpServer()).post('/products/import'),
    )
      .send({ csv })
      .expect(201);

    const body = response.body as ImportResultBody;
    expect(body.filas[0].estado).toBe('OK');
    expect(body.filas[0].sku).toMatch(/^P\d+$/);

    await trackCreatedByName(nombreProducto);
  });

  it('una fila con precio inválido se reporta como error sin abortar las demás filas del archivo', async () => {
    const nombreBueno1 = `Fila Buena 1 Test ${Date.now()}`;
    const nombreMalo = `Fila Mala Test ${Date.now()}`;
    const nombreBueno2 = `Fila Buena 2 Test ${Date.now()}`;
    const skuBueno1 = `FILA-BUENA-1-${Date.now()}`;
    const skuBueno2 = `FILA-BUENA-2-${Date.now()}`;

    const csv =
      'nombre,sku,precio,costo,stock\n' +
      `${nombreBueno1},${skuBueno1},10.00,5.00,1\n` +
      `${nombreMalo},SKU-MALO,no-es-un-numero,5.00,1\n` +
      `${nombreBueno2},${skuBueno2},20.00,10.00,2\n`;

    const response = await owned(
      request(app.getHttpServer()).post('/products/import'),
    )
      .send({ csv })
      .expect(201);

    const body = response.body as ImportResultBody;
    expect(body.filasCount).toBe(3);
    expect(body.exitosas).toBe(2);
    expect(body.fallidas).toBe(1);
    expect(body.filas[1]).toMatchObject({ linea: 3, estado: 'ERROR' });
    expect(body.filas[1].mensaje).toMatch(/precio/);

    await trackCreatedByName(nombreBueno1);
    await trackCreatedByName(nombreBueno2);

    const filaMalaProducto = await prisma.product.findFirst({
      where: { nombre: nombreMalo },
    });
    expect(filaMalaProducto).toBeNull();

    const variantBuena1 = await prisma.variant.findUnique({
      where: { sku: skuBueno1 },
    });
    const variantBuena2 = await prisma.variant.findUnique({
      where: { sku: skuBueno2 },
    });
    expect(variantBuena1).not.toBeNull();
    expect(variantBuena2).not.toBeNull();
  });

  it('SKU duplicado contra uno ya existente se reporta como error de fila (409 traducido, no 500)', async () => {
    const nombreProducto = `Producto SKU Dup Test ${Date.now()}`;
    const skuExistente = `SKU-YA-EXISTE-${Date.now()}`;

    // Primer import: crea la variante original.
    await owned(request(app.getHttpServer()).post('/products/import'))
      .send({
        csv:
          'nombre,sku,precio,costo,stock\n' +
          `${nombreProducto},${skuExistente},10.00,5.00,1\n`,
      })
      .expect(201);
    await trackCreatedByName(nombreProducto);

    // Segundo import: mismo SKU, otro producto.
    const response = await owned(
      request(app.getHttpServer()).post('/products/import'),
    )
      .send({
        csv:
          'nombre,sku,precio,costo,stock\n' +
          `Otro Producto ${Date.now()},${skuExistente},99.00,50.00,1\n`,
      })
      .expect(201);

    const body = response.body as ImportResultBody;
    expect(body.filas[0]).toMatchObject({ estado: 'ERROR' });
    expect(body.filas[0].mensaje).toBe('Ya existe una variante con ese SKU');
  });
});
