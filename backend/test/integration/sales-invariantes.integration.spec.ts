import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Prisma,
  PrismaClient,
  PaymentMetodo,
  CashMovementReferenciaTipo,
  CashRegisterSessionEstado,
  UserRole,
  ReturnTipo,
  SaleEstado,
  SettingTipo,
  type Sale,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StockService } from '../../src/modules/stock/stock.service';
import { CashRegisterService } from '../../src/modules/cash-registers/cash-register.service';
import { SettingsService } from '../../src/common/settings/settings.service';
import { SalesService } from '../../src/modules/sales/sales.service';

// Fase 04a (T4.8) — tests de integración escritos ANTES de la
// implementación de `SalesService.reconciliar()`, contra Postgres real
// (nunca mockeado, BLUEPRINT §9.8, excepción "plata y stock/caja": tests
// primero, sesión aislada).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` (T4.8, Etapa 4);
// `BLUEPRINT.md` §6 completa (los 15 invariantes, encabezado de la
// sección: "las tres primeras además un chequeo de reconciliación
// ejecutable" — invariante 3 es una de esas tres); `state/reports/
// modulo-sales-spec.md` sección 3 ("Invariantes", los que este módulo
// garantiza directamente) y sección 9 ("Tests necesarios", viñeta "Test
// de invariantes dedicado (T4.8)", que agrega explícitamente 12 y 13/15
// aunque no estén en la lista original del ticket, "porque son
// invariantes que este módulo sí garantiza"); `backend/prisma/
// schema.prisma` (modelos `Sale`/`SaleItem`/`SaleDiscount`/`Payment`/
// `Return`/`Setting`, solo como tipos/columnas, nunca lógica).
//
// `SalesService.reconciliar()` NO existe todavía — se crea en la Fase 04
// (implementación, otra sesión). `crearVenta`/`anularVenta` SÍ existen y
// están VERDE desde T4.1-T4.7 (excepción explícita del prompt de esta
// fase: se importa la clase `SalesService` para usarlos como SETUP de
// estos tests — nunca se leyó `sales.service.ts`, ni ningún otro archivo
// de `src/modules/` salvo IMPORT DE TIPO de `stock/stock.service.ts` y
// `cash-registers/cash-register.service.ts`, y la ESTRUCTURA MECÁNICA
// (`createVariant`/`openSession`/`closeAnyOpenSessionDirect`,
// `insertReturnDirect`, patrón de limpieza en `afterAll`) de
// `sales-anulacion.integration.spec.ts`, nunca su lógica de negocio).
//
// Los tests de `reconciliar()` en sí llaman al método a través de un cast
// a un tipo local `SalesServiceWithReconciliar` (mismo truco documentado
// en el encabezado T4.8 de `sales.service.spec.ts`) para que la llamada
// compile y falle en tiempo de EJECUCIÓN con `TypeError: ...reconciliar is
// not a function` — el rojo correcto para esa parte del ticket. Los tests
// dedicados de invariantes 4/5/7/12/13/15 llaman solo a `crearVenta`/
// `anularVenta` (ya implementados) y por lo tanto pueden pasar en verde
// desde ahora — eso es la confirmación esperada de que T4.1-T4.7 ya
// garantizan esos invariantes por construcción, no un error de esta fase.

const prisma = new PrismaClient();

interface SalesReconciliationMismatch {
  saleId: number;
  totalGuardado: Prisma.Decimal;
  sumaPagos: Prisma.Decimal;
}

interface SalesServiceWithReconciliar {
  reconciliar(): Promise<SalesReconciliationMismatch[]>;
}

function asReconciliable(service: SalesService): SalesServiceWithReconciliar {
  return service as unknown as SalesServiceWithReconciliar;
}

describe('sales — invariantes (integration, T4.8)', () => {
  let app: INestApplication;
  let stockService: StockService;
  let cashRegisterService: CashRegisterService;
  let settingsService: SettingsService;
  let salesService: SalesService;

  let ownerId: number;

  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdSessionIds: number[] = [];
  const createdSaleIds: number[] = [];
  const createdReturnIds: number[] = [];

  async function createVariant(
    overrides: Partial<{
      precioVenta: string;
      costoActual: string;
      stockActual: number;
    }> = {},
  ): Promise<{ id: number; productId: number }> {
    const product = await prisma.product.create({
      data: { nombre: `Producto test invariantes ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-INVARIANTES-${randomUUID()}`,
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

  async function insertReturnDirect(
    saleId: number,
    sessionId: number,
    userId: number,
  ): Promise<number> {
    const ret = await prisma.return.create({
      data: {
        saleId,
        fecha: new Date(),
        userId,
        cashRegisterSessionId: sessionId,
        tipo: ReturnTipo.DEVOLUCION,
        totalDevuelto: new Prisma.Decimal('10.00'),
      },
    });
    createdReturnIds.push(ret.id);
    return ret.id;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    stockService = app.get(StockService);
    cashRegisterService = app.get(CashRegisterService);
    settingsService = app.get(SettingsService);
    const prismaService = app.get(PrismaService);
    void settingsService;

    salesService = new SalesService(
      prismaService,
      stockService,
      cashRegisterService,
      settingsService,
    );

    const owner = await prisma.user.create({
      data: {
        email: `sales-invariantes-owner-${Date.now()}@manitas.local`,
        passwordHash: await argon2.hash('password123'),
        nombre: 'Owner de prueba (invariantes)',
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
    // Los `returns` insertados directo tienen que borrarse ANTES que las
    // ventas que referencian (`returns_sale_id_fkey ON DELETE RESTRICT`).
    if (createdReturnIds.length > 0) {
      await prisma.return.deleteMany({
        where: { id: { in: createdReturnIds } },
      });
    }

    // Mismo patrón de limpieza que `sales-anulacion.integration.spec.ts`.
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
        await prisma.saleDiscount.deleteMany({
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

  // ─── reconciliar() — invariante 3 (T4.8, método nuevo) ──────────────────

  describe('SalesService.reconciliar (invariante 3)', () => {
    it('varias ventas reales sin diferencias, incluida una con descuento + ajuste de redondeo + pago mixto: reconcilia sin diferencias', async () => {
      const variantA = await createVariant({
        precioVenta: '150.00',
        stockActual: 10,
      });
      const variantB = await createVariant({
        precioVenta: '999.00',
        stockActual: 10,
      });
      await openSession(ownerId, '0.00');

      // Venta simple, un solo pago en efectivo.
      const saleSimple = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variantA.id, cantidad: 2 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(saleSimple.id);

      // Venta con descuento + ajuste de redondeo + pago mixto (efectivo +
      // tarjeta), subtotal 999, descuento 10% = 99.90, ajuste -0.05,
      // total = 999 - 99.90 - 0.05 = 899.05.
      const saleCompleja = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variantB.id, cantidad: 1 }],
          discounts: [
            {
              descripcion: 'Descuento 10%',
              porcentaje: new Prisma.Decimal('10'),
            },
          ],
          ajusteRedondeo: new Prisma.Decimal('-0.05'),
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('400.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_DEBITO,
              monto: new Prisma.Decimal('499.05'),
            },
          ],
        }),
      );
      createdSaleIds.push(saleCompleja.id);

      const mismatches = await asReconciliable(salesService).reconciliar();
      const nuestrosIds = new Set([saleSimple.id, saleCompleja.id]);
      const nuestrosMismatches = mismatches.filter((m) =>
        nuestrosIds.has(m.saleId),
      );

      expect(nuestrosMismatches).toEqual([]);
    });

    it('una venta anulada sigue reconciliando sin diferencias (RN-8: anular no borra ni edita payments/total originales)', async () => {
      const variant = await createVariant({
        precioVenta: '200.00',
        stockActual: 10,
      });
      await openSession(ownerId, '0.00');

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('200.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      await prisma.$transaction((tx) =>
        salesService.anularVenta(tx, {
          saleId: sale.id,
          userId: ownerId,
          esOwner: true,
        }),
      );

      const mismatches = await asReconciliable(salesService).reconciliar();
      const elNuestro = mismatches.find((m) => m.saleId === sale.id);

      expect(elNuestro).toBeUndefined();
    });

    it('detecta un desajuste real: una venta con sales.total alterado a mano por fuera del servicio aparece en la lista con los valores correctos', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      await openSession(ownerId, '0.00');

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
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      // Corrompe sales.total a propósito, evitando el servicio — solo para
      // probar que reconciliar() detecta un desajuste real y no
      // únicamente confirma el camino feliz (mismo criterio que T2.8/T3.6).
      await prisma.sale.update({
        where: { id: sale.id },
        data: { total: new Prisma.Decimal('999.00') },
      });

      const mismatches = await asReconciliable(salesService).reconciliar();
      const elNuestro = mismatches.find((m) => m.saleId === sale.id);

      expect(elNuestro).toBeDefined();
      expect(new Prisma.Decimal(elNuestro!.totalGuardado).toString()).toBe(
        '999',
      );
      expect(new Prisma.Decimal(elNuestro!.sumaPagos).toString()).toBe('100');
    });
  });

  // ─── Invariante 4 — total == subtotal - descuento_total + ajuste_redondeo ──

  describe('invariante 4 — total == subtotal - descuento_total + ajuste_redondeo', () => {
    it('venta real con descuento y ajuste de redondeo no triviales: la ecuación completa se cumple contra los valores persistidos', async () => {
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 10,
      });
      await openSession(ownerId, '0.00');

      // subtotal 1000, descuento 100 (10%), ajuste -0.50 => total 899.50.
      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 1 }],
          discounts: [
            {
              descripcion: 'Descuento 10%',
              porcentaje: new Prisma.Decimal('10'),
            },
          ],
          ajusteRedondeo: new Prisma.Decimal('-0.50'),
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('899.50'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });

      expect(dbSale.subtotal.toString()).toBe('1000');
      expect(dbSale.descuentoTotal.toString()).toBe('100');
      expect(dbSale.ajusteRedondeo.toString()).toBe('-0.5');
      expect(dbSale.total.toString()).toBe('899.5');
      expect(
        dbSale.subtotal
          .minus(dbSale.descuentoTotal)
          .plus(dbSale.ajusteRedondeo)
          .equals(dbSale.total),
      ).toBe(true);
    });
  });

  // ─── Invariante 5 — stock_actual >= 0 salvo permitir_venta_sin_stock ────

  describe('invariante 5 — stock_actual >= 0 salvo permitir_venta_sin_stock', () => {
    it('stock normal: nunca queda negativo tras una venta real', async () => {
      const variant = await createVariant({
        precioVenta: '50.00',
        stockActual: 5,
      });
      await openSession(ownerId, '0.00');

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [{ variantId: variant.id, cantidad: 5 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('250.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const dbVariant = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(dbVariant.stockActual).toBe(0);
      expect(dbVariant.stockActual).toBeGreaterThanOrEqual(0);
    });

    it('con permitir_venta_sin_stock activo, una venta que deja el stock en negativo persiste igual (consultado directo)', async () => {
      const variant = await createVariant({
        precioVenta: '50.00',
        stockActual: 2,
      });
      await openSession(ownerId, '0.00');

      const original = await prisma.setting.findUnique({
        where: { clave: 'permitir_venta_sin_stock' },
      });

      try {
        await prisma.setting.upsert({
          where: { clave: 'permitir_venta_sin_stock' },
          update: { valor: 'true' },
          create: {
            clave: 'permitir_venta_sin_stock',
            valor: 'true',
            tipo: SettingTipo.BOOL,
          },
        });

        const sale = await prisma.$transaction((tx) =>
          salesService.crearVenta(tx, {
            userId: ownerId,
            esOwner: true,
            idempotencyKey: randomUUID(),
            items: [{ variantId: variant.id, cantidad: 5 }],
            payments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('250.00'),
              },
            ],
          }),
        );
        createdSaleIds.push(sale.id);

        const dbVariant = await prisma.variant.findUniqueOrThrow({
          where: { id: variant.id },
        });
        expect(dbVariant.stockActual).toBe(-3);
      } finally {
        if (original) {
          await prisma.setting.update({
            where: { clave: 'permitir_venta_sin_stock' },
            data: { valor: original.valor },
          });
        } else {
          await prisma.setting.deleteMany({
            where: { clave: 'permitir_venta_sin_stock' },
          });
        }
      }
    });
  });

  // ─── Invariante 7 — solo EFECTIVO genera cash_movements ─────────────────

  describe('invariante 7 — de los payments de una venta, solo EFECTIVO genera cash_movements', () => {
    it('venta con los 4 métodos de pago combinados: el único cash_movement generado es por el monto EFECTIVO', async () => {
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId, '0.00');

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
  });

  // ─── Invariante 12 — subtotal/descuento_total/total contra las sumas ───

  describe('invariante 12 — subtotal == SUM(sale_items.subtotal), descuento_total == SUM(sale_discounts.monto), SUM(sale_items.neto_linea) == total', () => {
    it('venta de 3 líneas con descuento (mismos números del test obligatorio #2 de BLUEPRINT §9.3): las tres igualdades se cumplen contra los valores persistidos', async () => {
      // subtotal = 10.00 + 10.00 + 10.01 = 30.01; descuento manual 3.01;
      // total = 27.00.
      const v1 = await createVariant({
        precioVenta: '10.00',
        stockActual: 5,
      });
      const v2 = await createVariant({
        precioVenta: '10.00',
        stockActual: 5,
      });
      const v3 = await createVariant({
        precioVenta: '10.01',
        stockActual: 5,
      });
      await openSession(ownerId, '0.00');

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [
            { variantId: v1.id, cantidad: 1 },
            { variantId: v2.id, cantidad: 1 },
            { variantId: v3.id, cantidad: 1 },
          ],
          discounts: [
            {
              descripcion: 'Descuento variado',
              monto: new Prisma.Decimal('3.01'),
            },
          ],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('27.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      const items = await prisma.saleItem.findMany({
        where: { saleId: sale.id },
      });
      const discounts = await prisma.saleDiscount.findMany({
        where: { saleId: sale.id },
      });

      const sumSubtotal = items.reduce(
        (acc, i) => acc.plus(i.subtotal),
        new Prisma.Decimal('0'),
      );
      const sumDescuento = discounts.reduce(
        (acc, d) => acc.plus(d.monto),
        new Prisma.Decimal('0'),
      );
      const sumNetoLinea = items.reduce(
        (acc, i) => acc.plus(i.netoLinea),
        new Prisma.Decimal('0'),
      );

      expect(sumSubtotal.equals(dbSale.subtotal)).toBe(true);
      expect(sumDescuento.equals(dbSale.descuentoTotal)).toBe(true);
      expect(sumNetoLinea.equals(dbSale.total)).toBe(true);
      expect(dbSale.total.toString()).toBe('27');
    });
  });

  // ─── Invariante 13 — ninguna venta ANULADA con returns.sale_id propio ──

  describe('invariante 13 — ninguna venta tiene a la vez estado ANULADA y devoluciones por returns.sale_id (AD-19)', () => {
    it('una venta con una devolución insertada directo: anularVenta la rechaza, y la consulta global confirma que nunca queda ANULADA con esa devolución', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId, '0.00');

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
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      await insertReturnDirect(sale.id, session.id, ownerId);

      await expect(
        prisma.$transaction((tx) =>
          salesService.anularVenta(tx, {
            saleId: sale.id,
            userId: ownerId,
            esOwner: true,
          }),
        ),
      ).rejects.toThrow();

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.estado).toBe(SaleEstado.COMPLETADA);

      // Aserción a nivel de invariante (no de comportamiento de servicio):
      // en TODA la base, ninguna venta ANULADA tiene una devolución propia.
      const violaciones = await prisma.sale.findMany({
        where: {
          estado: SaleEstado.ANULADA,
          returnsOriginadas: { some: {} },
        },
        select: { id: true },
      });
      expect(violaciones).toEqual([]);
    });
  });

  // ─── Invariante 15 — ninguna venta con pago CREDITO_DEVOLUCION queda ANULADA ──

  describe('invariante 15 — ninguna venta con un pago CREDITO_DEVOLUCION puede quedar ANULADA', () => {
    it('una venta con un payment CREDITO_DEVOLUCION insertado directo: anularVenta la rechaza, y la consulta global confirma que nunca queda ANULADA con ese método', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      await openSession(ownerId, '0.00');

      const sale: Sale = await prisma.$transaction((tx) =>
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
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      // `crearVenta` no genera CREDITO_DEVOLUCION todavía (es de `returns`)
      // — se inserta directo, sorteando esa limitación, solo para poder
      // probar el invariante del lado de `anularVenta`.
      await prisma.payment.create({
        data: {
          saleId: sale.id,
          metodo: PaymentMetodo.CREDITO_DEVOLUCION,
          monto: new Prisma.Decimal('10.00'),
        },
      });

      await expect(
        prisma.$transaction((tx) =>
          salesService.anularVenta(tx, {
            saleId: sale.id,
            userId: ownerId,
            esOwner: true,
          }),
        ),
      ).rejects.toThrow();

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.estado).toBe(SaleEstado.COMPLETADA);

      // Aserción a nivel de invariante: en TODA la base, ninguna venta
      // ANULADA tiene un payment de método CREDITO_DEVOLUCION.
      const violaciones = await prisma.sale.findMany({
        where: {
          estado: SaleEstado.ANULADA,
          payments: { some: { metodo: PaymentMetodo.CREDITO_DEVOLUCION } },
        },
        select: { id: true },
      });
      expect(violaciones).toEqual([]);
    });
  });
});
