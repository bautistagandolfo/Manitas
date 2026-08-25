import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Prisma,
  PrismaClient,
  PaymentMetodo,
  CashMovementReferenciaTipo,
  CashRegisterSessionEstado,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StockService } from '../../src/modules/stock/stock.service';
import { CashRegisterService } from '../../src/modules/cash-registers/cash-register.service';
import { SettingsService } from '../../src/common/settings/settings.service';
import { SalesService } from '../../src/modules/sales/sales.service';

// Fase 04a (T4.4) — tests de integración de `payments` contra Postgres real.
//
// T4.4 ("Pagos: N por venta, validación suma = total, impacto en caja solo
// si es efectivo") ya está MAYORMENTE construido: fue parte del trabajo
// necesario de T4.1/T4.2/T4.3 (no se puede cerrar una venta sin resolver
// los pagos). Este archivo no reconstruye ese flujo desde cero — verifica a
// fondo lo que la especificación exige de `payments`, incluyendo casos
// límite. Fuente: `BLUEPRINT.md` §5.3 (paso 5), §3.4 (modelo `payments`),
// AD-3, AD-8, invariantes 3 y 7; `state/reports/modulo-sales-spec.md`
// (RN-1 paso 5, sección 3 invariantes 3/7, sección 6 "cantidad en cero o
// negativa" como precedente de criterio); `backend/prisma/schema.prisma`
// (modelo `Payment`, enum `PaymentMetodo`);
// `backend/prisma/migrations/20260823002959_init/migration.sql`
// (`payments_monto_check CHECK (monto > 0)`, dato de schema, no de lógica
// de `sales.service.ts`, que esta sesión tiene prohibido abrir).
//
// Mismo patrón mecánico que `sales.integration.spec.ts` (T4.1): AppModule
// real, `SalesService` instanciado a mano con los colaboradores del
// contenedor, `prisma.$transaction` directo (no hay `SalesController`
// todavía), arrays de ids para limpieza en `afterAll`.
//
// ─── Hallazgo confirmado empíricamente en esta sesión ────────────────────
//
// Un pago con `monto <= 0` combinado con otro pago que hace que la SUMA
// total siga siendo exactamente igual a `sales.total` (invariante 3) NO es
// rechazado por ninguna validación de aplicación antes de escribir: pasa el
// único chequeo que existe hoy (`SUM(payments.monto) == total`) sin
// problema, porque una suma puede dar el número correcto con un sumando en
// cero. Recién explota contra el `CHECK (monto > 0)` crudo de la tabla
// `payments`, dentro de `tx.sale.create(...)` (nested write), con un
// `PrismaClientUnknownRequestError` de Postgres (code 23514,
// "violates check constraint payments_monto_check") — NO con un error de
// negocio limpio. Confirmado corriendo el escenario contra la
// implementación real (ver el test de más abajo): mensaje crudo de
// Postgres, no un 400 de validación. Es el mismo criterio que la propia
// spec ya aplica a `sale_items.cantidad` (sección 6, "Cantidad en cero o
// negativa: rechazada... más validación de DTO para un 400 limpio en vez
// del CHECK crudo, mismo criterio que el resto del sistema") — `payments`
// hoy no tiene ese equivalente. El test de abajo queda en rojo por esta
// ausencia real de validación, no por un error de test.

const prisma = new PrismaClient();

describe('sales — payments (integration, T4.4)', () => {
  let app: INestApplication;
  let cashRegisterService: CashRegisterService;
  let salesService: SalesService;

  let ownerId: number;

  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdSessionIds: number[] = [];
  const createdSaleIds: number[] = [];

  async function createVariant(
    overrides: Partial<{
      precioVenta: string;
      costoActual: string;
      stockActual: number;
    }> = {},
  ): Promise<{ id: number; productId: number }> {
    const product = await prisma.product.create({
      data: { nombre: `Producto test pagos ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-PAGOS-${randomUUID()}`,
        precioVenta: new Prisma.Decimal(overrides.precioVenta ?? '100.00'),
        costoActual: new Prisma.Decimal(overrides.costoActual ?? '60.00'),
        stockActual: overrides.stockActual ?? 10,
      },
    });
    createdVariantIds.push(variant.id);
    return variant;
  }

  async function openSession(
    userId: number,
    montoInicial = '0.00',
  ): Promise<{ id: number }> {
    const session = await prisma.$transaction((tx) =>
      cashRegisterService.abrirSesion(tx, {
        montoInicial: new Prisma.Decimal(montoInicial),
        userId,
      }),
    );
    createdSessionIds.push(session.id);
    return session;
  }

  async function closeAnyOpenSessionDirect(): Promise<void> {
    const open = await prisma.cashRegisterSession.findFirst({
      where: { estado: CashRegisterSessionEstado.ABIERTA },
    });
    if (open) {
      await prisma.cashRegisterSession.update({
        where: { id: open.id },
        data: {
          estado: CashRegisterSessionEstado.CERRADA,
          fechaCierre: new Date(),
          userIdCierre: open.userIdApertura,
          montoDeclarado: open.montoInicial,
          montoSistema: open.montoInicial,
          diferencia: new Prisma.Decimal('0.00'),
        },
      });
      createdSessionIds.push(open.id);
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const stockService = app.get(StockService);
    cashRegisterService = app.get(CashRegisterService);
    const settingsService = app.get(SettingsService);
    const prismaService = app.get(PrismaService);

    salesService = new SalesService(
      prismaService,
      stockService,
      cashRegisterService,
      settingsService,
    );

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: `sales-payments-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (pagos)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);
  });

  afterEach(async () => {
    await closeAnyOpenSessionDirect();
  });

  afterAll(async () => {
    for (const id of new Set(createdSessionIds)) {
      await prisma.cashRegisterSession.update({
        where: { id },
        data: { estado: CashRegisterSessionEstado.ABIERTA },
      });

      const salesInSession = await prisma.sale.findMany({
        where: { cashRegisterSessionId: id },
        select: { id: true },
      });
      const saleIdsInSession = salesInSession.map((s) => s.id);

      if (saleIdsInSession.length > 0) {
        await prisma.payment.deleteMany({
          where: { saleId: { in: saleIdsInSession } },
        });
        await prisma.saleItem.deleteMany({
          where: { saleId: { in: saleIdsInSession } },
        });
      }
      await prisma.cashMovement.deleteMany({ where: { sessionId: id } });
      if (saleIdsInSession.length > 0) {
        await prisma.sale.deleteMany({
          where: { id: { in: saleIdsInSession } },
        });
      }
      await prisma.cashRegisterSession.delete({ where: { id } });
    }

    if (createdVariantIds.length > 0) {
      await prisma.stockMovement.deleteMany({
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

  describe('Hallazgo confirmado — pago con monto <= 0 que igual suma el total correcto', () => {
    it('un pago de $0 + un pago que cubre el total exacto: NO debe registrarse como venta válida, y el rechazo debe ser un error de validación limpio, nunca el CHECK crudo de la base — nada debe quedar escrito', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId);

      await expect(
        prisma.$transaction((tx) =>
          salesService.crearVenta(tx, {
            userId: ownerId,
            esOwner: true,
            idempotencyKey: randomUUID(),
            items: [{ variantId: variant.id, cantidad: 1 }],
            payments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('0.00'),
              },
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
          }),
        ),
        // Expectativa de negocio (mismo criterio que "cantidad > 0" en
        // sale_items, spec sección 6): un mensaje de validación limpio, NO
        // el texto crudo del CHECK de Postgres. Confirmado empíricamente
        // (exploración de esta sesión) que hoy el error real es
        // "PrismaClientUnknownRequestError" con el texto de Postgres
        // "violates check constraint \"payments_monto_check\"" — este
        // test queda en rojo por esa razón real, no por un error de test.
      ).rejects.toThrow(/monto.*(positivo|mayor a 0|inv[aá]lido)/i);

      const salesInSession = await prisma.sale.findMany({
        where: { cashRegisterSessionId: session.id },
      });
      expect(salesInSession).toHaveLength(0);

      const paymentsWritten = await prisma.payment.findMany({
        where: { sale: { cashRegisterSessionId: session.id } },
      });
      expect(paymentsWritten).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(10);
    });

    it('un pago con monto NEGATIVO + un pago que compensa la suma al total exacto: mismo rechazo esperado, nada escrito', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId);

      await expect(
        prisma.$transaction((tx) =>
          salesService.crearVenta(tx, {
            userId: ownerId,
            esOwner: true,
            idempotencyKey: randomUUID(),
            items: [{ variantId: variant.id, cantidad: 1 }],
            payments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('-50.00'),
              },
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('150.00'),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/monto.*(positivo|mayor a 0|inv[aá]lido)/i);

      const salesInSession = await prisma.sale.findMany({
        where: { cashRegisterSessionId: session.id },
      });
      expect(salesInSession).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(10);
    });
  });

  describe('N pagos reales de métodos distintos en una sola venta (AD-3, invariantes 3 y 7)', () => {
    it('4 pagos, uno de cada método del enum (EFECTIVO, TARJETA_DEBITO, TARJETA_CREDITO, TRANSFERENCIA): las 4 filas de payments quedan persistidas y el cash_movement es solo por la parte en EFECTIVO', async () => {
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('250.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_DEBITO,
              monto: new Prisma.Decimal('250.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('250.00'),
            },
            {
              metodo: PaymentMetodo.TRANSFERENCIA,
              monto: new Prisma.Decimal('250.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const payments = await prisma.payment.findMany({
        where: { saleId: sale.id },
        orderBy: { id: 'asc' },
      });
      expect(payments).toHaveLength(4);
      expect(payments.map((p) => p.metodo).sort()).toEqual(
        [
          PaymentMetodo.EFECTIVO,
          PaymentMetodo.TARJETA_DEBITO,
          PaymentMetodo.TARJETA_CREDITO,
          PaymentMetodo.TRANSFERENCIA,
        ].sort(),
      );
      const sumMonto = payments.reduce(
        (sum, p) => sum.plus(p.monto),
        new Prisma.Decimal(0),
      );
      expect(sumMonto.toString()).toBe('1000');

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.total.toString()).toBe('1000');

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          sessionId: session.id,
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(cashMovs).toHaveLength(1);
      expect(cashMovs[0].monto.toString()).toBe('250');
    });

    it('N pagos con MÁS de un EFECTIVO mezclados con otros métodos (2 efectivo + crédito + transferencia): el cash_movement suma los dos efectivo en UN solo movimiento, no uno por pago', async () => {
      const variant = await createVariant({
        precioVenta: '500.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('150.00'),
            },
            {
              metodo: PaymentMetodo.TRANSFERENCIA,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const payments = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(payments).toHaveLength(4);
      const efectivoCount = payments.filter(
        (p) => p.metodo === PaymentMetodo.EFECTIVO,
      ).length;
      expect(efectivoCount).toBe(2);

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          sessionId: session.id,
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(cashMovs).toHaveLength(1);
      expect(cashMovs[0].monto.toString()).toBe('200');
    });

    it('ningún pago en EFECTIVO, N pagos de otros métodos (débito + crédito + transferencia): la venta se registra pero NO genera ningún cash_movement', async () => {
      const variant = await createVariant({
        precioVenta: '900.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.TARJETA_DEBITO,
              monto: new Prisma.Decimal('300.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('300.00'),
            },
            {
              metodo: PaymentMetodo.TRANSFERENCIA,
              monto: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const payments = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(payments).toHaveLength(3);

      const cashMovs = await prisma.cashMovement.findMany({
        where: { sessionId: session.id },
      });
      expect(cashMovs).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(4);
    });
  });

  describe('Campo referencia (BLUEPRINT §3.4: "últimos dígitos, nº de operación")', () => {
    it('se persiste EXACTAMENTE el valor recibido cuando se manda', async () => {
      const variant = await createVariant({
        precioVenta: '300.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      void session;

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.TARJETA_DEBITO,
              monto: new Prisma.Decimal('300.00'),
              referencia: '4242',
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const payment = await prisma.payment.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      expect(payment.referencia).toBe('4242');
    });

    it('queda null (no undefined, no string vacío) cuando NO se manda', async () => {
      const variant = await createVariant({
        precioVenta: '150.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      void session;

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const payment = await prisma.payment.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      expect(payment.referencia).toBeNull();
      expect(payment.referencia).not.toBe('');
      expect(payment.referencia).not.toBeUndefined();
    });
  });
});
