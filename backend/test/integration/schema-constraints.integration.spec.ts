import { PrismaClient } from '@prisma/client';

// Verifica que cada restricción de base de la fase 01 efectivamente
// RECHAZA el dato inválido contra Postgres real — no alcanza con que
// exista en el esquema (criterio de validación de la fase).

const prisma = new PrismaClient();

let userId: number;
let productId: number;
let variantId: number;
let sessionId: number;
let saleId: number;

beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      email: 'constraints-test@manitas.local',
      passwordHash: 'x',
      nombre: 'Test',
      rol: 'SELLER',
    },
  });
  userId = user.id;

  const product = await prisma.product.create({
    data: { nombre: 'Producto de prueba' },
  });
  productId = product.id;

  const variant = await prisma.variant.create({
    data: {
      productId,
      sku: 'SKU-CONSTRAINTS-TEST',
      precioVenta: '100.00',
      costoActual: '50.00',
    },
  });
  variantId = variant.id;

  const session = await prisma.cashRegisterSession.create({
    data: {
      fechaApertura: new Date(),
      userIdApertura: userId,
      montoInicial: '0.00',
    },
  });
  sessionId = session.id;

  const sale = await prisma.sale.create({
    data: {
      fecha: new Date(),
      userId,
      cashRegisterSessionId: sessionId,
      subtotal: '100.00',
      descuentoTotal: '0.00',
      total: '100.00',
    },
  });
  saleId = sale.id;
});

afterAll(async () => {
  await prisma.payment.deleteMany({ where: { saleId } });
  await prisma.saleItem.deleteMany({ where: { saleId } });
  await prisma.sale.deleteMany({ where: { id: saleId } });
  await prisma.cashRegisterSession.deleteMany({ where: { id: sessionId } });
  await prisma.variant.deleteMany({ where: { id: variantId } });
  await prisma.product.deleteMany({ where: { id: productId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('Restricciones de base — fase 01', () => {
  it('rechaza dos variantes del mismo producto sin talle ni color (UNIQUE NULLS NOT DISTINCT)', async () => {
    // Producto propio y aislado: el producto de la fixture ya tiene una
    // variante sin talle ni color, y colisionaría en el primer insert.
    const product = await prisma.product.create({
      data: { nombre: 'Producto sin talle ni color' },
    });

    const dup = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: 'SKU-DUP-1',
        precioVenta: '10.00',
        costoActual: '5.00',
      },
    });

    await expect(
      prisma.variant.create({
        data: {
          productId: product.id,
          sku: 'SKU-DUP-2',
          precioVenta: '10.00',
          costoActual: '5.00',
        },
      }),
    ).rejects.toThrow();

    await prisma.variant.delete({ where: { id: dup.id } });
    await prisma.product.delete({ where: { id: product.id } });
  });

  it('rechaza abrir una segunda cash_register_session mientras hay una ABIERTA', async () => {
    // La fixture de beforeAll ya dejó una sesión ABIERTA.
    await expect(
      prisma.cashRegisterSession.create({
        data: {
          fechaApertura: new Date(),
          userIdApertura: userId,
          montoInicial: '0.00',
        },
      }),
    ).rejects.toThrow();
  });

  it('rechaza un cash_movement de VENTA con monto negativo', async () => {
    await expect(
      prisma.cashMovement.create({
        data: {
          sessionId,
          fecha: new Date(),
          tipo: 'VENTA',
          monto: '-50.00',
          descripcion: 'venta con signo mal',
          userId,
        },
      }),
    ).rejects.toThrow();
  });

  it('rechaza un cash_movement de GASTO con monto positivo', async () => {
    await expect(
      prisma.cashMovement.create({
        data: {
          sessionId,
          fecha: new Date(),
          tipo: 'GASTO',
          monto: '50.00',
          descripcion: 'gasto con signo mal',
          userId,
        },
      }),
    ).rejects.toThrow();
  });

  it('acepta la convención de signo correcta (control positivo)', async () => {
    const movement = await prisma.cashMovement.create({
      data: {
        sessionId,
        fecha: new Date(),
        tipo: 'VENTA',
        monto: '50.00',
        descripcion: 'venta con signo bien',
        userId,
      },
    });
    expect(movement.id).toBeDefined();
    await prisma.cashMovement.delete({ where: { id: movement.id } });
  });

  it('rechaza un sale_item con cantidad 0 o negativa', async () => {
    await expect(
      prisma.saleItem.create({
        data: {
          saleId,
          variantId,
          descripcionSnapshot: 'Producto de prueba',
          cantidad: 0,
          precioUnitario: '100.00',
          costoUnitario: '50.00',
          subtotal: '0.00',
          netoLinea: '0.00',
          netoUnitario: '0.00',
        },
      }),
    ).rejects.toThrow();
  });

  it('rechaza un payment con monto 0 o negativo', async () => {
    await expect(
      prisma.payment.create({
        data: { saleId, metodo: 'EFECTIVO', monto: '0.00' },
      }),
    ).rejects.toThrow();
  });

  it('rechaza un expense con monto 0 o negativo', async () => {
    const category = await prisma.expenseCategory.findFirstOrThrow({
      where: { nombre: 'Otros' },
    });

    await expect(
      prisma.expense.create({
        data: {
          fecha: new Date(),
          expenseCategoryId: category.id,
          descripcion: 'gasto inválido',
          monto: '0.00',
          medioPago: 'EFECTIVO',
          userId,
        },
      }),
    ).rejects.toThrow();
  });

  it('rechaza un segundo usuario con el mismo email (unique)', async () => {
    await expect(
      prisma.user.create({
        data: {
          email: 'constraints-test@manitas.local',
          passwordHash: 'y',
          nombre: 'Duplicado',
          rol: 'SELLER',
        },
      }),
    ).rejects.toThrow();
  });

  it('rechaza dos sales con la misma idempotency_key', async () => {
    const first = await prisma.sale.create({
      data: {
        fecha: new Date(),
        userId,
        cashRegisterSessionId: sessionId,
        subtotal: '10.00',
        descuentoTotal: '0.00',
        total: '10.00',
        idempotencyKey: 'idem-test-key-1',
      },
    });

    await expect(
      prisma.sale.create({
        data: {
          fecha: new Date(),
          userId,
          cashRegisterSessionId: sessionId,
          subtotal: '10.00',
          descuentoTotal: '0.00',
          total: '10.00',
          idempotencyKey: 'idem-test-key-1',
        },
      }),
    ).rejects.toThrow();

    await prisma.sale.delete({ where: { id: first.id } });
  });
});
