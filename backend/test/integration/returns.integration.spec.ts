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
      stockService,
      salesService,
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

      // T5.5: `payments.return_id` (nuevo, crédito de devolución diferido)
      // referencia `returns.id` — un `payment` de una venta-cambio puede
      // apuntar a la devolución que lo originó. Por eso `payment` (más
      // abajo) tiene que borrarse ANTES que `return`, no después como
      // antes de T5.5: borrar `return` primero violaría esa FK en
      // cualquier test de CAMBIO. `return_items`/`return_payments` no
      // tienen ese problema (nada más los referencia) — se borran ya, sin
      // esperar. `returns.sale_id`/`returns.sale_nueva_id` (FK a `sales`)
      // siguen exigiendo que `return` se borre ANTES que `sale`, más
      // abajo.
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
      if (returnIdsInSession.length > 0) {
        await prisma.return.deleteMany({
          where: { id: { in: returnIdsInSession } },
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
    it('devolución completa de una línea, reintegro 100% efectivo: return/return_items/return_payments quedan coherentes, la venta original no cambia, hay un stock_movement DEVOLUCION (T5.2) y un cash_movement DEVOLUCION (T5.3)', async () => {
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

      // T5.2 (reingreso de stock) ya existe — reingresaStock: true en la
      // única línea de esta devolución tiene que dejar un stock_movement
      // DEVOLUCION referenciando esta devolución. T5.3 (movimiento de
      // caja) también ya existe: el reintegro es 100% EFECTIVO, así que
      // tiene que haber exactamente un cash_movement DEVOLUCION
      // referenciando esta devolución, con el monto NEGATIVO (AD-8,
      // `cash_movements_monto_sign_check`: DEVOLUCION siempre < 0 — sale
      // del cajón).
      const stockMovs = await prisma.stockMovement.findMany({
        where: {
          referenciaTipo: StockMovementReferenciaTipo.RETURN,
          referenciaId: devolucion.id,
        },
      });
      expect(stockMovs).toHaveLength(1);
      expect(stockMovs[0].tipo).toBe('DEVOLUCION');
      expect(stockMovs[0].delta).toBe(2);
      expect(stockMovs[0].variantId).toBe(variant.id);

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.RETURN,
          referenciaId: devolucion.id,
        },
      });
      expect(cashMovs).toHaveLength(1);
      expect(cashMovs[0].tipo).toBe('DEVOLUCION');
      expect(cashMovs[0].monto.toString()).toBe('-300');
      expect(cashMovs[0].sessionId).toBe(session.id);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      // 10 (inicial) - 2 (vendidas) + 2 (reingresadas por la devolución,
      // T5.2) = 10.
      expect(variantAfter.stockActual).toBe(10);
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

    // Fase 08 (QA adversarial) — hallazgo real: `crearDevolucion` nunca
    // validaba que los `saleItemId` mandados pertenecieran a la `saleId`
    // declarada — buscaba `sale_items` solo por su propio `id`, sin
    // `where: { saleId }`. Un `saleItemId` de una venta COMPLETAMENTE
    // DISTINTA pasaba igual: se leían `netoLinea`/`costoUnitario` de esa
    // línea ajena, se validaba el tope contra su propio acumulado (sin
    // relación con `saleId`), y la `Return` quedaba creada con
    // `sale_id` apuntando a una venta que en realidad no tiene esa
    // línea — integridad de datos rota, no explotable para robar plata
    // directamente (el importe sigue siendo el de la línea real), pero
    // corrompe la trazabilidad venta↔devolución y podría distorsionar
    // el CMV de `resultados` (Etapa 6, que filtra por `reingresa_stock`
    // asumiendo que la línea realmente pertenece a esa venta).
    it('saleItemId de OTRA venta (manipulación de IDs): rechaza con "no existe en esta venta", no crea nada', async () => {
      const variantA = await createVariant({ precioVenta: '100.00' });
      const variantB = await createVariant({ precioVenta: '250.00' });
      await openSession(ownerId);
      const ventaA = await createSaleFixture({
        userId: ownerId,
        variantId: variantA.id,
        cantidad: 1,
        precioVenta: '100.00',
      });
      const ventaB = await createSaleFixture({
        userId: ownerId,
        variantId: variantB.id,
        cantidad: 1,
        precioVenta: '250.00',
      });

      // saleId de la venta A, pero saleItemId de la línea de la venta B
      // — completamente ajena.
      await expect(
        prisma.$transaction((tx) =>
          returnsService.crearDevolucion(tx, {
            saleId: ventaA.saleId,
            items: [
              {
                saleItemId: ventaB.saleItemId,
                cantidad: 1,
                reingresaStock: true,
              },
            ],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('250.00'),
              },
            ],
            userId: ownerId,
            esOwner: false,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/no existe en esta venta/i);

      const returnsA = await prisma.return.findMany({
        where: { saleId: ventaA.saleId },
      });
      expect(returnsA).toHaveLength(0);
      const returnsB = await prisma.return.findMany({
        where: { saleId: ventaB.saleId },
      });
      expect(returnsB).toHaveLength(0);

      // La línea real de la venta B tampoco quedó afectada — ninguna
      // devolución "fantasma" contra ella.
      const returnItemsDeB = await prisma.returnItem.findMany({
        where: { saleItemId: ventaB.saleItemId },
      });
      expect(returnItemsDeB).toHaveLength(0);
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

  // Fase 04a (T5.2) — tests NUEVOS de integración contra Postgres real,
  // agregados sin tocar ninguna aserción de los describes de arriba (T5.1)
  // salvo las dos ya actualizadas explícitamente en el primer test de
  // "camino feliz" (comentario ahí mismo explica por qué). Fuente:
  // `state/reports/modulo-returns-spec.md` sección 5 paso 12 y BLUEPRINT
  // AD-8/§3.3/§5.4/invariante 6/§9.4.
  describe('ReturnsService.crearDevolucion — T5.2 reingreso de stock', () => {
    it('camino feliz, reingresaStock: true: el stock_movement real queda en la base con los campos correctos y variants.stock_actual vuelve a subir la cantidad exacta', async () => {
      const variant = await createVariant({
        precioVenta: '90.00',
        stockActual: 6,
      });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 3,
        precioVenta: '90.00',
      });

      const variantAfterVenta = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfterVenta.stockActual).toBe(3); // 6 - 3

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          items: [{ saleItemId, cantidad: 3, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('270.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      const stockMovs = await prisma.stockMovement.findMany({
        where: {
          referenciaTipo: StockMovementReferenciaTipo.RETURN,
          referenciaId: devolucion.id,
        },
      });
      expect(stockMovs).toHaveLength(1);
      expect(stockMovs[0].tipo).toBe('DEVOLUCION');
      expect(stockMovs[0].delta).toBe(3);
      expect(stockMovs[0].variantId).toBe(variant.id);
      expect(stockMovs[0].userId).toBe(ownerId);

      const variantAfterDevolucion = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfterDevolucion.stockActual).toBe(6); // 3 + 3 reingresadas
    });

    it('devolución con DOS líneas, reingresando solo una: solo esa variante sube de stock, la otra queda igual', async () => {
      const variantA = await createVariant({
        precioVenta: '50.00',
        stockActual: 10,
      });
      const variantB = await createVariant({
        precioVenta: '70.00',
        stockActual: 10,
      });
      await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [
            { variantId: variantA.id, cantidad: 2 },
            { variantId: variantB.id, cantidad: 1 },
          ],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('170.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const saleWithItems = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true },
      });
      const itemA = saleWithItems.items.find(
        (i) => i.variantId === variantA.id,
      )!;
      const itemB = saleWithItems.items.find(
        (i) => i.variantId === variantB.id,
      )!;

      await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId: sale.id,
          items: [
            { saleItemId: itemA.id, cantidad: 2, reingresaStock: true },
            { saleItemId: itemB.id, cantidad: 1, reingresaStock: false },
          ],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('170.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      const variantAAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variantA.id },
      });
      const variantBAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variantB.id },
      });
      // A: 10 - 2 (venta) + 2 (reingreso) = 10.
      expect(variantAAfter.stockActual).toBe(10);
      // B: 10 - 1 (venta), sin reingreso: queda en 9.
      expect(variantBAfter.stockActual).toBe(9);
    });

    it('rollback: si la devolución se rechaza (venta ANULADA), ningún stock_movement de tipo DEVOLUCION queda creado', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
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

      const stockMovs = await prisma.stockMovement.findMany({
        where: { variantId: variant.id, tipo: 'DEVOLUCION' },
      });
      expect(stockMovs).toHaveLength(0);
    });
  });

  // Fase 04a (T5.3) — tests NUEVOS de integración contra Postgres real,
  // agregados sin tocar ninguna aserción de los describes de arriba (T5.1/
  // T5.2) salvo la única ya actualizada explícitamente en el primer test
  // de "camino feliz" (comentario ahí mismo explica por qué). Fuente:
  // `state/reports/modulo-returns-spec.md` sección 5 paso 13 y BLUEPRINT
  // AD-8/invariante 7/§3.6.
  describe('ReturnsService.crearDevolucion — T5.3 movimiento de caja por reintegro en efectivo', () => {
    it('camino feliz, reintegro 100% efectivo: el cash_movement real queda en la base con tipo DEVOLUCION y el monto negativo del reintegro', async () => {
      const variant = await createVariant({
        precioVenta: '90.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '90.00',
      });

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('90.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.RETURN,
          referenciaId: devolucion.id,
        },
      });
      expect(cashMovs).toHaveLength(1);
      expect(cashMovs[0].tipo).toBe('DEVOLUCION');
      expect(cashMovs[0].monto.toString()).toBe('-90');
      expect(cashMovs[0].sessionId).toBe(session.id);
      expect(cashMovs[0].userId).toBe(ownerId);
    });

    it('reintegro 100% tarjeta: no genera ningún cash_movement nuevo', async () => {
      const variant = await createVariant({
        precioVenta: '120.00',
        stockActual: 5,
      });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '120.00',
      });

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('120.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.RETURN,
          referenciaId: devolucion.id,
        },
      });
      expect(cashMovs).toHaveLength(0);
    });

    it('rollback: si la devolución se rechaza (venta ANULADA), ningún cash_movement de tipo DEVOLUCION queda creado', async () => {
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

      const cashMovsAntes = await prisma.cashMovement.count({
        where: { tipo: 'DEVOLUCION' },
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
      ).rejects.toThrow(/anulada/i);

      const cashMovsDespues = await prisma.cashMovement.count({
        where: { tipo: 'DEVOLUCION' },
      });
      expect(cashMovsDespues).toBe(cashMovsAntes);
    });
  });

  // Fase 04a (T5.4) — tests de integración escritos ANTES de cualquier
  // cambio de implementación, en sesión AISLADA. Fuente única:
  // `docs/build-protocol/state/reports/modulo-returns-spec.md` RN-6,
  // sección 2 (aclaración explícita: `return_items.costo_unitario` se
  // copia tal cual de `sale_items.costo_unitario`, mismo congelado que ya
  // hizo `sales`, BLUEPRINT AD-5 — no hay ninguna resta de costo que este
  // módulo ejecute; es `resultados`, Etapa 6, §5.6, quien filtra por
  // `reingresa_stock = true` después). Contra Postgres real, para probar
  // de verdad el congelado: se cambia `variant.costoActual` DESPUÉS de la
  // venta, directo en la base, y se confirma que la devolución sigue
  // usando el costo VIEJO leído de `sale_items`, no el actual.
  describe('T5.4 — costo_unitario congelado, para el CMV de resultados (BLUEPRINT §5.6, RN-6)', () => {
    it('costo_unitario de la devolución coincide con el congelado en sale_items al momento de la venta, no con costo_actual de la variante si éste cambió DESPUÉS (AD-5)', async () => {
      const variant = await createVariant({
        precioVenta: '120.00',
        costoActual: '50.00',
        stockActual: 10,
      });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variant.id,
        cantidad: 1,
        precioVenta: '120.00',
      });

      const saleItemAntes = await prisma.saleItem.findUniqueOrThrow({
        where: { id: saleItemId },
      });
      expect(saleItemAntes.costoUnitario.toString()).toBe('50');

      // El costo de reposición de la variante cambia DESPUÉS de la venta —
      // directo en la base, como haría un reingreso de mercadería (T2.x).
      await prisma.variant.update({
        where: { id: variant.id },
        data: { costoActual: new Prisma.Decimal('999.00') },
      });

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('120.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      const dbReturnItem = await prisma.returnItem.findFirstOrThrow({
        where: { returnId: devolucion.id },
      });
      // Costo viejo, congelado en sale_items al momento de la venta — no
      // los 999 que la variante tiene ahora.
      expect(dbReturnItem.costoUnitario.toString()).toBe('50');
    });

    it('con DOS líneas de costos distintos y reingresaStock distinto, cada return_item conserva SU costo_unitario, sin mezclarse entre líneas', async () => {
      const variantA = await createVariant({
        precioVenta: '90.00',
        costoActual: '40.00',
        stockActual: 10,
      });
      const variantB = await createVariant({
        precioVenta: '60.00',
        costoActual: '22.50',
        stockActual: 10,
      });
      await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: randomUUID(),
          items: [
            { variantId: variantA.id, cantidad: 2 },
            { variantId: variantB.id, cantidad: 1 },
          ],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('240.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const saleWithItems = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true },
      });
      const itemA = saleWithItems.items.find(
        (i) => i.variantId === variantA.id,
      )!;
      const itemB = saleWithItems.items.find(
        (i) => i.variantId === variantB.id,
      )!;
      expect(itemA.costoUnitario.toString()).toBe('40');
      expect(itemB.costoUnitario.toString()).toBe('22.5');

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId: sale.id,
          items: [
            { saleItemId: itemA.id, cantidad: 2, reingresaStock: true },
            { saleItemId: itemB.id, cantidad: 1, reingresaStock: false },
          ],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('240.00'),
            },
          ],
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      const dbItems = await prisma.returnItem.findMany({
        where: { returnId: devolucion.id },
      });
      const returnItemA = dbItems.find((i) => i.saleItemId === itemA.id)!;
      const returnItemB = dbItems.find((i) => i.saleItemId === itemB.id)!;

      expect(returnItemA.costoUnitario.toString()).toBe('40');
      expect(returnItemA.reingresaStock).toBe(true);
      expect(returnItemB.costoUnitario.toString()).toBe('22.5');
      expect(returnItemB.reingresaStock).toBe(false);
    });
  });

  // ─── Fase 04a (T5.5) — CAMBIO: devolución + venta nueva ligadas, contra
  // Postgres real (BLUEPRINT §5.4, RN-9, invariante 14, AMB-16 RESUELTA).
  // No se abrió `returns.service.ts` ni `sales.service.ts` para escribir
  // este bloque.
  describe('ReturnsService.crearDevolucion — T5.5 CAMBIO', () => {
    it('cambio completo, precio igual: venta nueva creada de verdad, con un payment CREDITO_DEVOLUCION y return_id igual al de la devolución; returns.sale_nueva_id apunta a esa venta; el stock de la variante devuelta sube y el de la variante nueva baja', async () => {
      const variantVieja = await createVariant({
        precioVenta: '150.00',
        stockActual: 10,
      });
      const variantNueva = await createVariant({
        precioVenta: '150.00',
        stockActual: 5,
      });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variantVieja.id,
        cantidad: 1,
        precioVenta: '150.00',
      });

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          tipo: 'CAMBIO',
          items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.CREDITO_DEVOLUCION,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
          ventaNueva: {
            items: [{ variantId: variantNueva.id, cantidad: 1 }],
            payments: [],
          },
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      expect(devolucion.tipo).toBe('CAMBIO');
      expect(devolucion.saleNuevaId).not.toBeNull();
      createdSaleIds.push(devolucion.saleNuevaId!);

      const ventaNueva = await prisma.sale.findUniqueOrThrow({
        where: { id: devolucion.saleNuevaId! },
        include: { payments: true, items: true },
      });
      expect(ventaNueva.total.toString()).toBe('150');
      expect(ventaNueva.payments).toHaveLength(1);
      expect(ventaNueva.payments[0].metodo).toBe(
        PaymentMetodo.CREDITO_DEVOLUCION,
      );
      expect(ventaNueva.payments[0].returnId).toBe(devolucion.id);
      expect(ventaNueva.items[0].variantId).toBe(variantNueva.id);

      const variantViejaAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variantVieja.id },
      });
      // 10 (inicial) - 1 (vendida en la venta original) + 1 (reingresada
      // por la devolución del cambio) = 10.
      expect(variantViejaAfter.stockActual).toBe(10);

      const variantNuevaAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variantNueva.id },
      });
      // 5 (inicial) - 1 (vendida en la venta nueva del cambio) = 4.
      expect(variantNuevaAfter.stockActual).toBe(4);
    });

    it('cambio, prenda nueva más cara: el pago extra en efectivo queda registrado en la venta nueva y genera su propio cash_movement de tipo VENTA', async () => {
      const variantVieja = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      const variantNueva = await createVariant({
        precioVenta: '150.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variantVieja.id,
        cantidad: 1,
        precioVenta: '100.00',
      });

      const devolucion: Return = await prisma.$transaction((tx) =>
        returnsService.crearDevolucion(tx, {
          saleId,
          tipo: 'CAMBIO',
          items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.CREDITO_DEVOLUCION,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
          ventaNueva: {
            items: [{ variantId: variantNueva.id, cantidad: 1 }],
            payments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('50.00'),
              },
            ],
          },
          userId: ownerId,
          esOwner: false,
          idempotencyKey: randomUUID(),
        }),
      );

      createdSaleIds.push(devolucion.saleNuevaId!);

      const ventaNueva = await prisma.sale.findUniqueOrThrow({
        where: { id: devolucion.saleNuevaId! },
        include: { payments: true },
      });
      expect(ventaNueva.total.toString()).toBe('150');
      expect(ventaNueva.payments).toHaveLength(2);
      const pagoEfectivo = ventaNueva.payments.find(
        (p) => p.metodo === PaymentMetodo.EFECTIVO,
      );
      expect(pagoEfectivo).toBeDefined();
      expect(pagoEfectivo!.monto.toString()).toBe('50');

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: devolucion.saleNuevaId!,
        },
      });
      expect(cashMovs).toHaveLength(1);
      expect(cashMovs[0].tipo).toBe('VENTA');
      expect(cashMovs[0].monto.toString()).toBe('50');
      expect(cashMovs[0].sessionId).toBe(session.id);
    });

    it('rollback: si la venta nueva se rechaza por un motivo real de sales (stock insuficiente de la variante nueva), TODA la transacción revierte — ni la devolución ni sus return_items/return_payments quedan creados', async () => {
      const variantVieja = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      const variantNueva = await createVariant({
        precioVenta: '100.00',
        stockActual: 0,
      });
      await openSession(ownerId);
      const { saleId, saleItemId } = await createSaleFixture({
        userId: ownerId,
        variantId: variantVieja.id,
        cantidad: 1,
        precioVenta: '100.00',
      });

      await expect(
        prisma.$transaction((tx) =>
          returnsService.crearDevolucion(tx, {
            saleId,
            tipo: 'CAMBIO',
            items: [{ saleItemId, cantidad: 1, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.CREDITO_DEVOLUCION,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
            ventaNueva: {
              items: [{ variantId: variantNueva.id, cantidad: 1 }],
              payments: [],
            },
            userId: ownerId,
            esOwner: false,
            idempotencyKey: randomUUID(),
          }),
        ),
      ).rejects.toThrow(/stock insuficiente/i);

      const returnsForSale = await prisma.return.findMany({
        where: { saleId },
      });
      expect(returnsForSale).toHaveLength(0);

      const variantViejaAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variantVieja.id },
      });
      // Solo lo que descontó la venta ORIGINAL — el cambio entero revirtió,
      // sin reingreso de stock de la línea devuelta.
      expect(variantViejaAfter.stockActual).toBe(9);

      const variantNuevaAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variantNueva.id },
      });
      expect(variantNuevaAfter.stockActual).toBe(0);
    });
  });

  // T5.6 explícito en el ROADMAP (Etapa 5) — test de concurrencia real del
  // invariante 8 (BLUEPRINT §6, ítem 8: `SUM(return_items.cantidad)` por
  // `sale_item_id` nunca supera la `cantidad` vendida en esa línea).
  // Fuente: `state/reports/modulo-returns-spec.md` sección 5, paso 4 ("Lock
  // de los `sale_items` involucrados, ordenado por id... sin este lock, dos
  // devoluciones parciales concurrentes de la MISMA línea leen el mismo
  // acumulado 'viejo' y las dos podrían pasar el tope de RN-4") y sección 9
  // ("Concurrencia real (Postgres, T5.6 del roadmap explícito): dos
  // devoluciones parciales simultáneas de la MISMA línea, cerca del tope —
  // una pasa, la otra rechaza por invariante 8, nunca las dos. Mismo patrón
  // que T4.9 de `sales` (repetido varias veces con datos frescos por
  // iteración)"). Mismo patrón MECÁNICO (no de lógica de negocio, módulo
  // distinto) que el describe 'T4.9' de `sales.integration.spec.ts`:
  // `Promise.allSettled` con dos llamadas reales contra Postgres, repetido
  // 5 veces con datos frescos por iteración — la ventana real de la carrera
  // es angosta, una sola vuelta podría no alcanzar a exponer una regresión
  // del lock.
  //
  // A diferencia de una Fase 04a típica (donde todo debe fallar por
  // ausencia de implementación), acá `ReturnsService.crearDevolucion` YA
  // EXISTE desde T5.1 y ya debería tomar el lock de `sale_items`
  // (BLUEPRINT §9.4) — así que es válido, y esperado, que este test PASE de
  // entrada si el lock está bien implementado. El mensaje de rechazo
  // esperado (`/supera|disponible/i`) es el mismo que ya usa, más arriba en
  // este archivo, el test secuencial de RN-4 ('cantidad supera lo vendido
  // disponible en la línea: rechaza y no crea nada', línea ~512) — no uno
  // inventado para esta sesión.
  describe('ReturnsService.crearDevolucion — T5.6 concurrencia real (invariante 8)', () => {
    it('dos devoluciones parciales simultáneas de la MISMA línea que juntas superan lo vendido (aunque cada una sola no): una pasa, la otra rechaza — nunca las dos, y la suma en base nunca supera lo vendido', async () => {
      const session = await openSession(ownerId);
      void session;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const variant = await createVariant({
          precioVenta: '50.00',
          stockActual: 20,
        });
        const { saleId, saleItemId } = await createSaleFixture({
          userId: ownerId,
          variantId: variant.id,
          cantidad: 10,
          precioVenta: '50.00',
        });

        // Línea vendida: 10 unidades, neto_linea total = 500.00 (sin
        // descuento). Cada devolución pide 6 (6 < 10: pasa el tope de RN-4
        // si se evalúa sola) pero juntas (12) superan las 10 vendidas — el
        // caso exacto que ejercita el lock de `sale_items` de la sección 5
        // de la spec, no una concurrencia trivial que ninguna de las dos
        // alcanzaría a superar el tope por sí misma.
        const [a, b] = await Promise.allSettled([
          prisma.$transaction((tx) =>
            returnsService.crearDevolucion(tx, {
              saleId,
              items: [{ saleItemId, cantidad: 6, reingresaStock: true }],
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
          prisma.$transaction((tx) =>
            returnsService.crearDevolucion(tx, {
              saleId,
              items: [{ saleItemId, cantidad: 6, reingresaStock: true }],
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
        ]);

        const results = [a, b];
        const fulfilled = results.filter(
          (r): r is PromiseFulfilledResult<Return> => r.status === 'fulfilled',
        );
        const rejected = results.filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );

        // Nunca las dos pasan (violaría el invariante 8: 12 > 10
        // vendidas), y nunca las dos rechazan (6 unidades solas, sin la
        // otra, están dentro del tope — alguna de las dos tiene que poder
        // devolverse).
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0].reason as Error).message).toMatch(
          /supera|disponible/i,
        );

        // Invariante 8 verificado con una query real contra la base
        // después de que ambas promesas resolvieron, no solo infiriendo
        // del resultado de las promesas: la suma de `return_items.cantidad`
        // para esta línea nunca puede superar la `cantidad` vendida (10).
        const sumaDevuelta = await prisma.returnItem.aggregate({
          where: { saleItemId },
          _sum: { cantidad: true },
        });
        expect(sumaDevuelta._sum.cantidad ?? 0).toBeLessThanOrEqual(10);
        expect(sumaDevuelta._sum.cantidad ?? 0).toBe(6);
      }
    });
  });
});
