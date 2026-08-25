import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Prisma,
  PrismaClient,
  PaymentMetodo,
  CashMovementTipo,
  CashMovementReferenciaTipo,
  StockMovementTipo,
  StockMovementReferenciaTipo,
  CashRegisterSessionEstado,
  UserRole,
  ReturnTipo,
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

// Fase 04a (T4.7) — tests de integración escritos ANTES de la
// implementación, contra Postgres real (nunca mockeado, BLUEPRINT §9.8,
// excepción "plata y stock/caja": tests primero, sesión aislada).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` (T4.7, Etapa 4);
// `BLUEPRINT.md` AD-19 (sección 2), invariantes 13/15 (sección 6), §5.3
// (reglas de anulación), §9.4 (lock de fila); `state/reports/
// modulo-sales-spec.md` RN-8, secciones 4.2, 5, 6, 7, 9;
// `backend/prisma/schema.prisma` (modelos `Sale`/`Return`, enums
// `SaleEstado`/`CashMovementTipo`/`StockMovementTipo`, confirmado que
// `ANULACION` existe en los dos últimos). Contrato de
// `SalesService.anularVenta(tx, input)` fijado en `sales.service.spec.ts`
// (ver el encabezado de la sección T4.7 de ese archivo) — no se repite
// acá.
//
// `anularVenta` NO existe todavía en `SalesService` (se crea en la Fase 04,
// otra sesión) — este archivo entero debe fallar al compilar por "Property
// 'anularVenta' does not exist on type 'SalesService'" en cada llamada de
// más abajo. Esa es la razón correcta de rojo para este ticket en
// particular (ver el comentario largo al final de `sales.service.spec.ts`
// para el porqué es aceptable acá, a diferencia de otros tickets de este
// módulo).
//
// Excepción explícita del prompt de esta fase: SÍ se importó el TIPO
// `CrearVentaInput` y la clase `SalesService` desde
// `../../src/modules/sales/sales.service` para poder llamar
// `salesService.crearVenta(tx, input)` como SETUP de estos tests
// (necesitan una venta real ya creada antes de poder anularla) — no se
// miró ninguna otra cosa de ese archivo, mismo criterio ya usado en T4.2
// (`sales-snapshot.integration.spec.ts`). Tampoco se leyó ninguna
// implementación de `src/modules/` salvo esa excepción y `stock/
// stock.service.ts`/`cash-registers/cash-register.service.ts` como IMPORT
// DE TIPO — la ESTRUCTURA MECÁNICA (nunca la lógica de negocio) de
// `sales.integration.spec.ts` (helpers `createVariant`/`openSession`/
// `closeAnyOpenSessionDirect`, patrón de limpieza en `afterAll`, patrón de
// concurrencia con `Promise.allSettled` repetido con datos frescos) se
// reusó tal cual como convención mecánica del repo.
//
// Inserción directa de `Return` por Prisma (sin que el módulo `returns`
// exista todavía): el modelo exige `saleId`, `fecha`, `userId`,
// `cashRegisterSessionId`, `tipo`, `totalDevuelto` — se usan los mínimos
// campos obligatorios, con `tipo: DEVOLUCION` y un `totalDevuelto`
// arbitrario ($10, no relevante para lo que este ticket verifica: el
// chequeo de RN-8 paso 4 es de EXISTENCIA de una fila con ese `saleId`,
// no de su contenido).

const prisma = new PrismaClient();

describe('sales — anulación (integration, T4.7)', () => {
  let app: INestApplication;
  let stockService: StockService;
  let cashRegisterService: CashRegisterService;
  let settingsService: SettingsService;
  let salesService: SalesService;

  let ownerId: number;
  let sellerId: number;

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
      data: { nombre: `Producto test anulación ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-ANULACION-${randomUUID()}`,
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

  // Setup mecánico: una venta real, ya cobrada, lista para anular. Reusa
  // `salesService.crearVenta` (permitido explícitamente por el prompt de
  // esta fase, ver el encabezado de arriba) — nunca escribe `sales` a mano
  // por Prisma directo.
  async function createSaleReadyToAnular(
    variantId: number,
    sessionUserId: number,
    payments: Array<{ metodo: PaymentMetodo; monto: string }>,
    cantidad = 2,
  ): Promise<Sale> {
    const sale = await prisma.$transaction((tx) =>
      salesService.crearVenta(tx, {
        userId: sessionUserId,
        esOwner: true,
        idempotencyKey: randomUUID(),
        items: [{ variantId, cantidad }],
        payments: payments.map((p) => ({
          metodo: p.metodo,
          monto: new Prisma.Decimal(p.monto),
        })),
      }),
    );
    createdSaleIds.push(sale.id);
    return sale;
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

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: `sales-anulacion-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (anulación)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `sales-anulacion-seller-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Seller de prueba (anulación)',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    sellerId = seller.id;
    createdUserIds.push(seller.id);
  });

  afterEach(async () => {
    await closeAnyOpenSessionDirect();
  });

  afterAll(async () => {
    // Los `returns` insertados directo tienen que borrarse ANTES que las
    // ventas que referencian (`returns_sale_id_fkey ON DELETE RESTRICT`,
    // migración `20260823002959_init`).
    if (createdReturnIds.length > 0) {
      await prisma.return.deleteMany({
        where: { id: { in: createdReturnIds } },
      });
    }

    // Mismo patrón de limpieza que `sales.integration.spec.ts`: reabrir
    // cada sesión antes de borrar (el trigger de inmutabilidad tras el
    // cierre bloquea el DELETE de `cash_movements` sobre una sesión
    // CERRADA), borrar las ventas de esa sesión primero (payments/items),
    // después los cash_movements, después la venta, después la sesión.
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

  describe('camino feliz — venta con efectivo', () => {
    it('anula: sales.estado = ANULADA, stock vuelve al valor original, un stock_movement ANULACION nuevo (además del VENTA original), un cash_movement ANULACION nuevo por el monto correcto, y la sesión queda con balance neto correcto', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId, '1000.00');

      const sale = await createSaleReadyToAnular(variant.id, ownerId, [
        { metodo: PaymentMetodo.EFECTIVO, monto: '200.00' },
      ]);

      const variantAfterVenta = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfterVenta.stockActual).toBe(8);

      const anulada = await prisma.$transaction((tx) =>
        salesService.anularVenta(tx, {
          saleId: sale.id,
          userId: ownerId,
          esOwner: true,
        }),
      );

      expect(anulada.estado).toBe('ANULADA');

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.estado).toBe('ANULADA');

      // Stock vuelto al valor original — ni una unidad de más ni de menos.
      const variantAfterAnulacion = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfterAnulacion.stockActual).toBe(10);

      // Dos filas de stock_movements para esta venta: la VENTA original
      // (nunca borrada ni editada) más la ANULACION nueva.
      const stockMovs = await prisma.stockMovement.findMany({
        where: {
          referenciaTipo: StockMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(stockMovs).toHaveLength(2);
      const stockTipos = stockMovs.map((m) => m.tipo).sort();
      expect(stockTipos).toEqual(
        [StockMovementTipo.ANULACION, StockMovementTipo.VENTA].sort(),
      );
      const anulacionMov = stockMovs.find(
        (m) => m.tipo === StockMovementTipo.ANULACION,
      );
      expect(anulacionMov?.delta).toBe(2);

      // Dos filas de cash_movements: VENTA original más ANULACION nueva.
      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          sessionId: session.id,
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(cashMovs).toHaveLength(2);
      const cashAnulacion = cashMovs.find(
        (m) => m.tipo === CashMovementTipo.ANULACION,
      );
      expect(cashAnulacion).toBeDefined();
      // El servicio de caja aplica el signo según `tipo` — ANULACION no
      // está en TIPOS_POSITIVOS, así que queda guardado en negativo.
      expect(cashAnulacion?.monto.toString()).toBe('-200');

      // Balance neto de la sesión: se anuló todo lo que se cobró, así que
      // el neto de movimientos de esta venta+anulación es 0.
      const sumaMovimientos = cashMovs.reduce(
        (sum, m) => sum.plus(m.monto),
        new Prisma.Decimal(0),
      );
      expect(sumaMovimientos.toString()).toBe('0');
    });
  });

  describe('anulación de venta 100% tarjeta', () => {
    it('revierte stock, SIN cash_movement de anulación (invariante 7 — nada entró en efectivo)', async () => {
      const variant = await createVariant({
        precioVenta: '150.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId, '500.00');

      const sale = await createSaleReadyToAnular(
        variant.id,
        ownerId,
        [{ metodo: PaymentMetodo.TARJETA_CREDITO, monto: '150.00' }],
        1,
      );

      await prisma.$transaction((tx) =>
        salesService.anularVenta(tx, {
          saleId: sale.id,
          userId: ownerId,
          esOwner: true,
        }),
      );

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(5);

      const cashMovsCount = await prisma.cashMovement.count({
        where: {
          sessionId: session.id,
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(cashMovsCount).toBe(0);
    });
  });

  describe('anulación de venta con pago MIXTO', () => {
    it('el cash_movement de anulación es solo por la parte EFECTIVO', async () => {
      const variant = await createVariant({
        precioVenta: '300.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId, '500.00');

      const sale = await createSaleReadyToAnular(
        variant.id,
        ownerId,
        [
          { metodo: PaymentMetodo.EFECTIVO, monto: '120.00' },
          { metodo: PaymentMetodo.TARJETA_DEBITO, monto: '180.00' },
        ],
        1,
      );

      await prisma.$transaction((tx) =>
        salesService.anularVenta(tx, {
          saleId: sale.id,
          userId: ownerId,
          esOwner: true,
        }),
      );

      const cashAnulacion = await prisma.cashMovement.findFirst({
        where: {
          sessionId: session.id,
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
          tipo: CashMovementTipo.ANULACION,
        },
      });
      expect(cashAnulacion).toBeDefined();
      expect(cashAnulacion?.monto.toString()).toBe('-120');
    });
  });

  describe('anulación rechazada — venta con una devolución existente (AD-19, invariante 13)', () => {
    it('rechaza sin revertir nada (ni stock, ni caja, ni estado)', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId, '500.00');

      const sale = await createSaleReadyToAnular(variant.id, ownerId, [
        { metodo: PaymentMetodo.EFECTIVO, monto: '200.00' },
      ]);

      await insertReturnDirect(sale.id, session.id, ownerId);

      await expect(
        prisma.$transaction((tx) =>
          salesService.anularVenta(tx, {
            saleId: sale.id,
            userId: ownerId,
            esOwner: true,
          }),
        ),
      ).rejects.toThrow(/devoluci/i);

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.estado).toBe('COMPLETADA');

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(3);

      const cashAnulacionCount = await prisma.cashMovement.count({
        where: {
          sessionId: session.id,
          referenciaId: sale.id,
          tipo: CashMovementTipo.ANULACION,
        },
      });
      expect(cashAnulacionCount).toBe(0);
    });
  });

  describe('anulación fuera de la sesión de caja actual', () => {
    it('rechaza — la venta se hizo en una sesión ya cerrada, distinta de la sesión ABIERTA actual', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const sessionOriginal = await openSession(ownerId, '500.00');

      const sale = await createSaleReadyToAnular(variant.id, ownerId, [
        { metodo: PaymentMetodo.EFECTIVO, monto: '200.00' },
      ]);

      await closeAnyOpenSessionDirect();
      const sessionNueva = await openSession(ownerId, '0.00');
      void sessionOriginal;

      await expect(
        prisma.$transaction((tx) =>
          salesService.anularVenta(tx, {
            saleId: sale.id,
            userId: ownerId,
            esOwner: true,
          }),
        ),
      ).rejects.toThrow(/mismo turno de caja/i);

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.estado).toBe('COMPLETADA');

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(3);

      const cashAnulacionCount = await prisma.cashMovement.count({
        where: { sessionId: sessionNueva.id, tipo: CashMovementTipo.ANULACION },
      });
      expect(cashAnulacionCount).toBe(0);
    });
  });

  describe('anulación de venta inexistente', () => {
    it('404, sin nada escrito', async () => {
      const session = await openSession(ownerId, '0.00');
      void session;

      await expect(
        prisma.$transaction((tx) =>
          salesService.anularVenta(tx, {
            saleId: 999999999,
            userId: ownerId,
            esOwner: true,
          }),
        ),
      ).rejects.toThrow(/venta no encontrada/i);
    });
  });

  describe('anulación de venta ya ANULADA', () => {
    it('anulada dos veces seguidas: la segunda rechaza, sin duplicar la reversión de stock/caja', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId, '500.00');

      const sale = await createSaleReadyToAnular(variant.id, ownerId, [
        { metodo: PaymentMetodo.EFECTIVO, monto: '200.00' },
      ]);

      await prisma.$transaction((tx) =>
        salesService.anularVenta(tx, {
          saleId: sale.id,
          userId: ownerId,
          esOwner: true,
        }),
      );

      await expect(
        prisma.$transaction((tx) =>
          salesService.anularVenta(tx, {
            saleId: sale.id,
            userId: ownerId,
            esOwner: true,
          }),
        ),
      ).rejects.toThrow(/ya está anulada/i);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      // Vuelto al original una sola vez, no duplicado.
      expect(variantAfter.stockActual).toBe(5);

      const anulacionMovs = await prisma.stockMovement.count({
        where: {
          variantId: variant.id,
          tipo: StockMovementTipo.ANULACION,
        },
      });
      expect(anulacionMovs).toBe(1);

      const cashAnulacionMovs = await prisma.cashMovement.count({
        where: {
          sessionId: session.id,
          referenciaId: sale.id,
          tipo: CashMovementTipo.ANULACION,
        },
      });
      expect(cashAnulacionMovs).toBe(1);
    });
  });

  describe('esOwner: false', () => {
    it('rechaza, sin nada escrito', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      await openSession(ownerId, '500.00');

      const sale = await createSaleReadyToAnular(variant.id, ownerId, [
        { metodo: PaymentMetodo.EFECTIVO, monto: '200.00' },
      ]);

      await expect(
        prisma.$transaction((tx) =>
          salesService.anularVenta(tx, {
            saleId: sale.id,
            userId: sellerId,
            esOwner: false,
          }),
        ),
      ).rejects.toThrow(/owner/i);

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.estado).toBe('COMPLETADA');
    });
  });

  // Mismo patrón que T4.9 y el resto de los tests de concurrencia del
  // repo: repetido varias veces con una venta fresca por iteración — la
  // ventana real de la carrera (dos transacciones peleando el lock de la
  // misma fila `sales`) es angosta, una sola vuelta podría no alcanzar a
  // exponer una regresión si el lock se rompe.
  describe('T4.7 — concurrencia: dos anulaciones simultáneas de la MISMA venta', () => {
    it('una sola tiene éxito; la otra rechaza con "ya está anulada"; nunca las dos revierten stock/caja', async () => {
      const session = await openSession(ownerId, '2000.00');

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const variant = await createVariant({
          precioVenta: '50.00',
          stockActual: 10,
        });

        const sale = await createSaleReadyToAnular(variant.id, ownerId, [
          { metodo: PaymentMetodo.EFECTIVO, monto: '100.00' },
        ]);

        const [a, b] = await Promise.allSettled([
          prisma.$transaction((tx) =>
            salesService.anularVenta(tx, {
              saleId: sale.id,
              userId: ownerId,
              esOwner: true,
            }),
          ),
          prisma.$transaction((tx) =>
            salesService.anularVenta(tx, {
              saleId: sale.id,
              userId: ownerId,
              esOwner: true,
            }),
          ),
        ]);

        const results = [a, b];
        const fulfilled = results.filter(
          (r): r is PromiseFulfilledResult<Sale> => r.status === 'fulfilled',
        );
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0].reason as Error).message).toMatch(
          /ya está anulada/i,
        );
        expect(fulfilled[0].value.estado).toBe('ANULADA');

        // Stock revertido exactamente una vez — vuelve al valor original,
        // nunca queda revertido dos veces (lo que dejaría el stock por
        // encima del original).
        const finalVariant = await prisma.variant.findUniqueOrThrow({
          where: { id: variant.id },
        });
        expect(finalVariant.stockActual).toBe(10);

        const anulacionStockMovs = await prisma.stockMovement.count({
          where: { variantId: variant.id, tipo: StockMovementTipo.ANULACION },
        });
        expect(anulacionStockMovs).toBe(1);

        const anulacionCashMovs = await prisma.cashMovement.count({
          where: {
            sessionId: session.id,
            referenciaId: sale.id,
            tipo: CashMovementTipo.ANULACION,
          },
        });
        expect(anulacionCashMovs).toBe(1);
      }
    });
  });
});
