import { PrismaClient, Prisma, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StockService } from '../../src/modules/stock/stock.service';

// T2.8 — invariante 1 (BLUEPRINT §6.1): variants.stock_actual ==
// SUM(stock_movements.delta). No es una verificación variante por
// variante (eso ya lo cubren los tests de integración de T2.4/T2.5/T2.6)
// sino el chequeo agregado que exige la sección 6 del blueprint —
// recorre TODAS las variantes de la base y compara cada una contra la
// suma de sus propios movimientos, corriendo contra Postgres real.

const prisma = new PrismaClient();
const stockService = new StockService(prisma as unknown as PrismaService);

async function createTestVariant(
  nombreProducto: string,
): Promise<{ productId: number; variantId: number }> {
  const product = await prisma.product.create({
    data: { nombre: nombreProducto },
  });
  const variant = await prisma.variant.create({
    data: {
      productId: product.id,
      sku: `RECON-TEST-${Date.now()}-${Math.random()}`,
      precioVenta: new Prisma.Decimal('50.00'),
      costoActual: new Prisma.Decimal('20.00'),
      stockActual: 0,
    },
  });
  return { productId: product.id, variantId: variant.id };
}

describe('StockService.reconciliar (integration, T2.8, invariante 1)', () => {
  let userId: number;
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `reconciliacion-test-${Date.now()}@manitas.local`,
        passwordHash: await argon2.hash('password123'),
        nombre: 'Owner de prueba (reconciliación)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    userId = user.id;
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
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it('entradas y ajustes válidos, incluida una variante dada de baja con stock > 0 (RN-7), reconcilian sin diferencias', async () => {
    const a = await createTestVariant(`Reconciliación A ${Date.now()}`);
    const b = await createTestVariant(`Reconciliación B ${Date.now()}`);
    const c = await createTestVariant(`Reconciliación C ${Date.now()}`);
    createdProductIds.push(a.productId, b.productId, c.productId);
    createdVariantIds.push(a.variantId, b.variantId, c.variantId);

    // Variante A: dos entradas (5 + 3 = 8).
    await prisma.$transaction((tx) =>
      stockService.registrarEntrada(tx, {
        variantId: a.variantId,
        cantidad: 5,
        costoUnitario: new Prisma.Decimal('10.00'),
        userId,
      }),
    );
    await prisma.$transaction((tx) =>
      stockService.registrarEntrada(tx, {
        variantId: a.variantId,
        cantidad: 3,
        costoUnitario: new Prisma.Decimal('11.00'),
        userId,
      }),
    );

    // Variante B: una entrada (10) y un ajuste negativo (-4) = 6.
    await prisma.$transaction((tx) =>
      stockService.registrarEntrada(tx, {
        variantId: b.variantId,
        cantidad: 10,
        costoUnitario: new Prisma.Decimal('9.00'),
        userId,
      }),
    );
    await prisma.$transaction((tx) =>
      stockService.registrarAjuste(tx, {
        variantId: b.variantId,
        delta: -4,
        motivo: 'Rotura en depósito',
        userId,
      }),
    );

    // Variante C: una entrada (5) y después se da de baja — RN-7 exige
    // que siga contando en la reconciliación con stock > 0.
    await prisma.$transaction((tx) =>
      stockService.registrarEntrada(tx, {
        variantId: c.variantId,
        cantidad: 5,
        costoUnitario: new Prisma.Decimal('7.00'),
        userId,
      }),
    );
    await prisma.variant.update({
      where: { id: c.variantId },
      data: { activo: false },
    });

    const mismatches = await stockService.reconciliar();
    const nuestrosIds = new Set([a.variantId, b.variantId, c.variantId]);
    const nuestrosMismatches = mismatches.filter((m) =>
      nuestrosIds.has(m.variantId),
    );

    expect(nuestrosMismatches).toEqual([]);
  });

  it('detecta un desajuste real: una variante con stock_actual alterado fuera de stock.service aparece en la lista con los valores correctos', async () => {
    const d = await createTestVariant(`Reconciliación D ${Date.now()}`);
    createdProductIds.push(d.productId);
    createdVariantIds.push(d.variantId);

    await prisma.$transaction((tx) =>
      stockService.registrarEntrada(tx, {
        variantId: d.variantId,
        cantidad: 10,
        costoUnitario: new Prisma.Decimal('15.00'),
        userId,
      }),
    );

    // Corrompe stock_actual a propósito, evitando stock.service — solo
    // para probar que reconciliar() detecta un desajuste real y no
    // únicamente confirma el camino feliz.
    await prisma.variant.update({
      where: { id: d.variantId },
      data: { stockActual: 999 },
    });

    const mismatches = await stockService.reconciliar();
    const elNuestro = mismatches.find((m) => m.variantId === d.variantId);

    expect(elNuestro).toEqual({
      variantId: d.variantId,
      stockActual: 999,
      sumaMovimientos: 10,
    });
  });
});
