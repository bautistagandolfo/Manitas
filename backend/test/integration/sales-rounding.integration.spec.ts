import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Prisma,
  PrismaClient,
  PaymentMetodo,
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

// Fase 04a (T4.6) — tests de integración escritos ANTES de la
// implementación del ajuste de redondeo, contra Postgres real (nunca
// mockeado, BLUEPRINT §9.8, excepción "plata y stock/caja": tests
// primero, sesión aislada de la que implementa).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` T4.6 y la nota en
// prosa "Hallazgos técnicos menores (fase 06)" bajo la tabla de Etapa 4
// ("`total >= 0` no se sigue automáticamente de las otras reglas del
// invariante 4... validación explícita + CHECK de base recomendado,
// asignado a T4.6"); `BLUEPRINT.md` §9.3 (reglas de redondeo, AD-14),
// AD-14 (sección 2), invariante 4 (sección 6); `9.4` (patrón de
// transacción, ya cubierto por otros archivos de este módulo);
// `state/reports/modulo-sales-spec.md` RN-6 (ajuste de redondeo), sección
// 3 (invariante 4, el hallazgo real con el ejemplo numérico), sección 7
// (tabla de errores, "El ajuste de redondeo deja el total en negativo");
// `backend/prisma/schema.prisma` modelo `Sale`, campo `ajusteRedondeo`
// (`Decimal(12,2)`, `@default(0)`, ya existe desde la fase 01);
// `backend/prisma/migrations/20260825131851_sales_descuento_total_check/migration.sql`
// como referencia del patrón de migración a mano ya usado en este módulo
// (T4.3) — NO copiado como contenido de negocio, solo como precedente de
// que este tipo de `CHECK` se agrega con una migración manual separada.
// NO se abrió `sales.service.ts`.
//
// No se abrió ningún archivo de `backend/src/modules/` salvo IMPORT DE
// TIPO (nunca contenido) de `stock/stock.service.ts` y
// `cash-registers/cash-register.service.ts`; se reusa/extiende la
// ESTRUCTURA MECÁNICA (nunca la lógica de negocio) de
// `test/integration/sales-discounts.integration.spec.ts` — mismo patrón
// de setup (`AppModule` real, usuarios OWNER/SELLER por Prisma directo,
// `createVariant`/`openSession`/`closeAnyOpenSessionDirect`, limpieza en
// `afterAll` con arrays de ids, incluyendo `sale_discounts`).
//
// Contrato ampliado de `crearVenta(tx, input)` para T4.6 (mismo que
// `sales.service.spec.ts`, no se repite la justificación acá):
// `ajusteRedondeo?: Prisma.Decimal.Value`, opcional, default `0`. Se pasa
// siempre a través de una variable con un tipo explícito más ancho
// (`CrearVentaInputT46`), nunca como objeto literal inline, para que la
// propiedad extra no dispare un error de compilación de TypeScript contra
// el tipo real (todavía angosto) — el rojo esperado acá es de
// aserción/runtime o del `CHECK` ausente de la base, no de compilación.

const prisma = new PrismaClient();

interface DiscountInputT43 {
  descripcion: string;
  porcentaje?: Prisma.Decimal.Value;
  monto?: Prisma.Decimal.Value;
}

interface CrearVentaInputT46 {
  userId: number;
  items: Array<{ variantId: number; cantidad: number }>;
  payments: Array<{
    metodo: PaymentMetodo;
    monto: Prisma.Decimal.Value;
    referencia?: string;
  }>;
  discounts?: DiscountInputT43[];
  esOwner: boolean;
  idempotencyKey: string;
  ajusteRedondeo?: Prisma.Decimal.Value;
}

describe('sales — ajuste de redondeo (integration, T4.6)', () => {
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

  async function createVariant(
    overrides: Partial<{
      precioVenta: string;
      costoActual: string;
      stockActual: number;
    }> = {},
  ): Promise<{ id: number; productId: number }> {
    const product = await prisma.product.create({
      data: { nombre: `Producto test redondeo ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-RED-${randomUUID()}`,
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

  // Mismo motivo que en `sales.integration.spec.ts`/`sales-discounts...`:
  // el índice único parcial de sesión ABIERTA bloquea abrir una nueva
  // mientras haya una sin cerrar.
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

    stockService = app.get(StockService);
    cashRegisterService = app.get(CashRegisterService);
    settingsService = app.get(SettingsService);
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
        email: `sales-rounding-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (redondeo)',
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

  describe('camino feliz — ajusteRedondeo positivo, persistido y coherente', () => {
    it('ajusteRedondeo = 0.30: sales.ajuste_redondeo y sales.total quedan persistidos, total = subtotal + ajuste_redondeo', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const input: CrearVentaInputT46 = {
        userId: ownerId,
        esOwner: true,
        idempotencyKey: randomUUID(),
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.30'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('0.30'),
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true },
      });
      expect(dbSale.subtotal.toString()).toBe('100');
      expect(dbSale.ajusteRedondeo.toString()).toBe('0.3');
      expect(dbSale.total.toString()).toBe('100.3');
      expect(dbSale.items[0].netoLinea.toString()).toBe('100.3');
    });
  });

  describe('camino feliz — ajusteRedondeo negativo, persistido y coherente', () => {
    it('ajusteRedondeo = -0.15: sales.ajuste_redondeo y sales.total quedan persistidos, total = subtotal - |ajuste_redondeo|', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const input: CrearVentaInputT46 = {
        userId: ownerId,
        esOwner: true,
        idempotencyKey: randomUUID(),
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('99.85'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('-0.15'),
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.ajusteRedondeo.toString()).toBe('-0.15');
      expect(dbSale.total.toString()).toBe('99.85');
    });
  });

  describe('rechazo — ajusteRedondeo que dejaría total negativo (invariante 4, hallazgo de la fase 06)', () => {
    it('subtotal=$0.50, descuento_total=$0.50, ajusteRedondeo=-$0.90 → total=-$0.90: rechaza, no crea fila en sales/sale_items/sale_discounts/stock_movements/cash_movements', async () => {
      const variant = await createVariant({
        precioVenta: '0.50',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      // El total (-$0.90) es intrínsecamente impagable con un monto
      // positivo real. Se manda un pago positivo arbitrario ($1.00),
      // deliberadamente distinto de cualquier total posible, para que el
      // rechazo solo pueda venir de la validación de `total >= 0` (que
      // tiene que ocurrir antes de comparar contra los pagos) — mismo
      // criterio que el test equivalente de `sales.service.spec.ts`. Un
      // pago de $0 dispararía en cambio la validación (ya existente) de
      // "el monto de cada pago tiene que ser mayor a 0", un rechazo real
      // pero por una razón distinta a la que este test verifica.
      const input: CrearVentaInputT46 = {
        userId: ownerId,
        esOwner: true,
        idempotencyKey: randomUUID(),
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento total',
            monto: new Prisma.Decimal('0.50'),
          },
        ],
        ajusteRedondeo: new Prisma.Decimal('-0.90'),
      };

      await expect(
        prisma.$transaction((tx) => salesService.crearVenta(tx, input)),
      ).rejects.toThrow(/ajuste de redondeo deja el total en negativo/i);

      const sales = await prisma.sale.findMany({
        where: { cashRegisterSessionId: session.id },
      });
      expect(sales).toHaveLength(0);

      const discounts = await prisma.saleDiscount.findMany({
        where: { sale: { cashRegisterSessionId: session.id } },
      });
      expect(discounts).toHaveLength(0);

      const items = await prisma.saleItem.findMany({
        where: { sale: { cashRegisterSessionId: session.id } },
      });
      expect(items).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(5);

      const stockMovs = await prisma.stockMovement.findMany({
        where: { variantId: variant.id },
      });
      expect(stockMovs).toHaveLength(0);

      const cashMovs = await prisma.cashMovement.findMany({
        where: { sessionId: session.id },
      });
      expect(cashMovs).toHaveLength(0);
    });
  });

  describe('CHECK de base para total >= 0 (sales_total_check, T4.6, defensa en profundidad) — todavía no existe', () => {
    it('el CHECK real de la base rechaza un INSERT directo con total < 0, sorteando el servicio (§3.6 de la spec, mismo criterio que sales_descuento_total_check de T4.3)', async () => {
      const session = await openSession(ownerId);

      // Se inserta directo por Prisma, sorteando `salesService.crearVenta`
      // por completo, para confirmar que la base misma rechaza un `total`
      // negativo — no alcanza con la validación de aplicación. Esta
      // constraint (`sales_total_check`) TODAVÍA NO EXISTE (T4.6 solo
      // escribe tests en esta fase, la migración es trabajo de la fase de
      // implementación) — este test queda en rojo por esa ausencia real,
      // no por un error de test.
      await expect(
        prisma.sale.create({
          data: {
            fecha: new Date(),
            userId: ownerId,
            cashRegisterSessionId: session.id,
            subtotal: new Prisma.Decimal('10.00'),
            descuentoTotal: new Prisma.Decimal('0.00'),
            ajusteRedondeo: new Prisma.Decimal('-0.99'),
            total: new Prisma.Decimal('-10.00'),
          },
        }),
      ).rejects.toThrow();

      const count = await prisma.sale.count({
        where: { cashRegisterSessionId: session.id },
      });
      expect(count).toBe(0);
    });
  });
});
