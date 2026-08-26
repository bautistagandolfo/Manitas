import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Prisma,
  PrismaClient,
  PaymentMetodo,
  CashMovementReferenciaTipo,
  StockMovementReferenciaTipo,
  CashRegisterSessionEstado,
  UserRole,
  type Return,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StockService } from '../../src/modules/stock/stock.service';
import { CashRegisterService } from '../../src/modules/cash-registers/cash-register.service';
import { SettingsService } from '../../src/common/settings/settings.service';
import { SalesService } from '../../src/modules/sales/sales.service';
import { ReturnsService } from '../../src/modules/returns/returns.service';
import { withIdempotency } from '../../src/common/idempotency/idempotency.util';
import { SETTINGS_KEYS } from '../../src/common/settings/settings-keys';

// Fase 04a (T5.1) — tests de integración escritos ANTES de la
// implementación, en sesión AISLADA, contra Postgres real (nunca
// mockeado, BLUEPRINT §9.8, excepción "plata y stock/caja": tests
// primero).
//
// Fuente única: mismos documentos que `returns.service.spec.ts` (ver el
// encabezado de ese archivo). Contrato de
// `ReturnsService.crearDevolucion(tx, input)` fijado ahí — no se repite
// acá en detalle, solo el resumen imprescindible para el setup.
//
// `returns.service.ts` NO existe todavía (se crea en la Fase 04, otra
// sesión) — este archivo entero debe fallar al compilar por "Cannot find
// module" en el import de `ReturnsService` de más arriba. Esa es la razón
// correcta de rojo para la Fase 04a, no un error a corregir.
//
// No se abrió ningún archivo de `backend/src/modules/` salvo IMPORT DE
// TIPO de `cash-registers/cash-register.service.ts` y `sales/sales.service.ts`
// (nunca se leyó su lógica de negocio, solo lo necesario para tipar/usar
// sus constructores y contratos ya VERDE, exactamente igual que
// `sales.integration.spec.ts` ya hace con `stock`/`cash-registers`), y la
// ESTRUCTURA MECÁNICA de `test/integration/sales.integration.spec.ts` /
// `sales-idempotency.integration.spec.ts` (setup con `AppModule` real,
// helpers `createVariant`/`openSession`/`closeAnyOpenSessionDirect`,
// patrón de limpieza en `afterAll`, patrón de doble click con
// `withIdempotency`) como convención mecánica del repo — nunca su lógica
// de negocio.
//
// Diseño: igual que `sales.integration.spec.ts` con T4.1 (sin
// `SalesController`/`SalesModule` todavía en aquel momento), acá tampoco
// hay `ReturnsController`/`ReturnsModule` (T5.1 no los construye) — se
// instancia `ReturnsService` directamente y se invoca `crearDevolucion`
// dentro de una transacción real de Prisma. Las ventas fixture se crean
// con `SalesService` real (ya VERDE, Fases 07-12 cerradas) para tener
// `sale_items.neto_linea` genuinos, calculados por el prorrateo real de
// `sales`, no inventados a mano.

const prisma = new PrismaClient();

describe('returns (integration, T5.1)', () => {
  let app: INestApplication;
  let stockService: StockService;
  let cashRegisterService: CashRegisterService;
  let settingsService: SettingsService;
  let salesService: SalesService;
  let returnsService: ReturnsService;

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
      data: { nombre: `Producto test devolución ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-DEVOLUCION-${randomUUID()}`,
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

  // Crea una venta real (vía `SalesService`, ya VERDE) de una sola línea,
  // cobrada 100% en efectivo, dentro de la sesión actualmente abierta.
  // Devuelve el `saleItemId` y el `netoLinea` REAL que `sales` calculó
  // (autoritativo, AD-18) — nunca un valor inventado a mano.
  async function createSaleFixture(params: {
    userId: number;
    variantId: number;
    cantidad: number;
    precioVenta: string;
  }): Promise<{
    saleId: number;
    saleItemId: number;
    netoLinea: Prisma.Decimal;
  }> {
    const monto = new Prisma.Decimal(params.precioVenta).times(params.cantidad);
    const sale = await prisma.$transaction((tx) =>
      salesService.crearVenta(tx, {
        userId: params.userId,
        esOwner: true,
        idempotencyKey: randomUUID(),
        items: [{ variantId: params.variantId, cantidad: params.cantidad }],
        payments: [{ metodo: PaymentMetodo.EFECTIVO, monto }],
      }),
    );
    createdSaleIds.push(sale.id);

    const withItems = await prisma.sale.findUniqueOrThrow({
      where: { id: sale.id },
      include: { items: true },
    });

    return {
      saleId: sale.id,
      saleItemId: withItems.items[0].id,
      netoLinea: withItems.items[0].netoLinea,
    };
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
    returnsService = new ReturnsService(
      prismaService,
      cashRegisterService,
      settingsService,
    );

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: `returns-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (devoluciones)',
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
    // Mismo motivo que `sales.integration.spec.ts`: reabrir una sesión por
    // vez, de punta a punta, antes de borrar (el índice único parcial de
    // sesión ABIERTA no tolera dos a la vez, y el trigger de inmutabilidad
    // de `cash_movements` bloquea el DELETE de limpieza sobre una sesión
    // CERRADA).
    for (const id of new Set(createdSessionIds)) {
      await prisma.cashRegisterSession.update({
        where: { id },
        data: { estado: CashRegisterSessionEstado.ABIERTA },
      });

      // Las devoluciones se borran ANTES que las ventas/sale_items que
      // referencian (`return_items.sale_item_id`, `returns.sale_id`).
      const returnsInSession = await prisma.return.findMany({
        where: { cashRegisterSessionId: id },
        select: { id: true },
      });
      const returnIdsInSession = returnsInSession.map((r) => r.id);
      if (returnIdsInSession.length > 0) {
        await prisma.returnPayment.deleteMany({
          where: { returnId: { in: returnIdsInSession } },
        });
        await prisma.returnItem.deleteMany({
          where: { returnId: { in: returnIdsInSession } },
        });
        await prisma.return.deleteMany({
          where: { id: { in: returnIdsInSession } },
        });
      }

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

  describe('ReturnsService.crearDevolucion — camino feliz', () => {
    it('devolución completa de una línea, reintegro 100% efectivo: return/return_items/return_payments quedan coherentes, la venta original no cambia, y NO hay stock_movements ni cash_movements de tipo RETURN (T5.2/T5.3)', async () => {
      const variant = await createVariant({
        precioVenta: '150.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId);
      const { saleId, saleItemId, netoLinea } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 2,
        precioVenta: '150.00',
      });
      expect(netoLinea.toString()).toBe('300');

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          items: [{ saleItemId, cantidad: 2, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('300.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(devolucion.totalDevuelto.toString()).toBe('300');
      expect(devolucion.saleId).toBe(saleId);
      expect(devolucion.tipo).toBe('DEVOLUCION');
      expect(devolucion.cashRegisterSessionId).toBe(session.id);

      const dbReturn = await prisma.return.findUniqueOrThrow({
        where: { id: devolucion.id },
        include: { items: true, returnPayments: true },
      });
      expect(dbReturn.items).toHaveLength(1);
      expect(dbReturn.items[0].netoLinea.toString()).toBe('300');
      expect(dbReturn.items[0].reingresaStock).toBe(true);
      expect(dbReturn.returnPayments).toHaveLength(1);
      expect(dbReturn.returnPayments[0].monto.toString()).toBe('300');

      // La venta original no se modifica.
      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: saleId },
      });
      expect(dbSale.estado).toBe('COMPLETADA');

      // T5.2 (reingreso de stock) y T5.3 (movimiento de caja) todavía no
      // existen: ningún movimiento nuevo con referencia a esta devolución.
      const stockMovs = await prisma.stockMovement.findMany({
        where: {
          referenciaTipo: StockMovementReferenciaTipo.RETURN,
          referenciaId: devolucion.id,
        },
      });
      expect(stockMovs).toHaveLength(0);

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.RETURN,
          referenciaId: devolucion.id,
        },
      });
      expect(cashMovs).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      // Solo bajó por la venta (10 - 2 = 8); la devolución no la tocó.
      expect(variantAfter.stockActual).toBe(8);
    });

    it('reingresaStock: false (prenda fallada): se reintegra el dinero igual, pero el dato queda persistido para que T5.2/resultados lo usen después', async () => {
      const variant = await createVariant({
        precioVenta: '80.00',
        stockActual: 5,
      });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '80.00',
      });

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          items: [{ saleItemId, cantidad: 1, reingresaStock: false }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('80.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      const dbItem = await prisma.returnItem.findFirstOrThrow({
        where: { returnId: devolucion.id },
      });
      expect(dbItem.reingresaStock).toBe(false);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      // Sin cambios de stock en ningún sentido — T5.1 nunca toca stock.
      expect(variantAfter.stockActual).toBe(4);
    });
  });

  describe('ReturnsService.crearDevolucion — rechazos con rollback completo', () => {
    it('venta ANULADA: rechaza y no crea ninguna fila en returns/return_items/return_payments', async () => {
      const variant = await createVariant({ precioVenta: '100.00' });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '100.00',
      });

      await prisma.$transaction((tx) =>
        salesService.anularVenta(tx, {
          saleId,
          userId: ownerId,
          esOwner: true,
        }),
      );

      await expect(
        prisma.$transaction((tx) =>
          returnsService.crearDevolucion(tx, {
            saleId,
            items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
            userId: ownerId,
            esOwner: false,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/anulada/i);

      const returns = await prisma.return.findMany({ where: { saleId } });
      expect(returns).toHaveLength(0);
    });

    it('sin sesión de caja abierta: rechaza y no crea nada', async () => {
      const variant = await createVariant({ precioVenta: '100.00' });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '100.00',
      });
      await closeAnyOpenSessionDirect();

      await expect(
        prisma.$transaction((tx) =>
          returnsService.crearDevolucion(tx, {
            saleId,
            items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
            userId: ownerId,
            esOwner: false,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/sesión de caja abierta/i);

      const returns = await prisma.return.findMany({ where: { saleId } });
      expect(returns).toHaveLength(0);
    });

    it('cantidad supera lo vendido disponible en la línea: rechaza y no crea nada', async () => {
      const variant = await createVariant({ precioVenta: '100.00' });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 2,
        precioVenta: '100.00',
      });

      await expect(
        prisma.$transaction((tx) =>
          returnsService.crearDevolucion(tx, {
            saleId,
            items: [{ saleItemId, cantidad: 3, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('300.00'),
              },
            ],
            userId: ownerId,
            esOwner: false,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/supera|disponible/i);

      const returns = await prisma.return.findMany({ where: { saleId } });
      expect(returns).toHaveLength(0);
    });

    it('fuera de plazo sin autorización: rechaza y no crea nada', async () => {
      const diasPlazo = await settingsService.getInt(
        SETTINGS_KEYS.DIAS_PLAZO_DEVOLUCION,
      );
      const variant = await createVariant({ precioVenta: '100.00' });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '100.00',
      });

      const fechaVieja = new Date();
      fechaVieja.setDate(fechaVieja.getDate() - (diasPlazo + 5));
      await prisma.sale.update({
        where: { id: saleId },
        data: { fecha: fechaVieja },
      });

      await expect(
        prisma.$transaction((tx) =>
          returnsService.crearDevolucion(tx, {
            saleId,
            items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
            userId: ownerId,
            esOwner: false,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/plazo/i);

      const returns = await prisma.return.findMany({ where: { saleId } });
      expect(returns).toHaveLength(0);
    });

    it('fuera de plazo CON autorización (esOwner: true): se acepta y autorizado_por_user_id queda seteado', async () => {
      const diasPlazo = await settingsService.getInt(
        SETTINGS_KEYS.DIAS_PLAZO_DEVOLUCION,
      );
      const variant = await createVariant({ precioVenta: '100.00' });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '100.00',
      });

      const fechaVieja = new Date();
      fechaVieja.setDate(fechaVieja.getDate() - (diasPlazo + 5));
      await prisma.sale.update({
        where: { id: saleId },
        data: { fecha: fechaVieja },
      });

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(devolucion.autorizadoPorUserId).toBe(ownerId);
    });

    it('SUM(return_payments) != total_devuelto: rechaza y no crea nada', async () => {
      const variant = await createVariant({ precioVenta: '100.00' });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 2,
        precioVenta: '100.00',
      });

      await expect(
        prisma.$transaction((tx) =>
          returnsService.crearDevolucion(tx, {
            saleId,
            items: [{ saleItemId, cantidad: 2, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('150.00'),
              },
            ],
            userId: ownerId,
            esOwner: false,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/no cubren|reintegr/i);

      const returns = await prisma.return.findMany({ where: { saleId } });
      expect(returns).toHaveLength(0);
    });
  });

  describe('ReturnsService.crearDevolucion — idempotencia (RN-9, §9.7)', () => {
    function crearDevolucionConIdempotencia(input: {
      saleId: number;
      items: Array<{
        saleItemId: number;
        cantidad: number;
        reingresaStock: boolean;
      }>;
      returnPayments: Array<{
        metodo: PaymentMetodo;
        monto: Prisma.Decimal.Value;
        referencia?: string;
      }>;
      userId: number;
      esOwner: boolean;
      idempotencyKey: string;
    }): Promise<Return> {
      return withIdempotency(
        () =>
          prisma.$transaction((tx) =>
            returnsService.crearDevolucion(tx, input),
          ),
        () =>
          prisma.return.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          }),
      );
    }

    it('mismo Idempotency-Key dos veces (llamadas secuenciales): la segunda devuelve la MISMA devolución, sin crear una segunda fila', async () => {
      const variant = await createVariant({ precioVenta: '100.00' });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '100.00',
      });
      const key = randomUUID();
      const input = {
        saleId,
        items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
        returnPayments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
        userId: ownerId,
        esOwner: false,
        idempotencyKey: key,
      };

      const first = await crearDevolucionConIdempotencia(input);
      const second = await crearDevolucionConIdempotencia(input);

      expect(second.id).toBe(first.id);

      const count = await prisma.return.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });
  });
});
