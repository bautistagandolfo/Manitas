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

// Fase 04a (T4.1) — tests de integración escritos ANTES de la
// implementación, contra Postgres real (nunca mockeado, BLUEPRINT §9.8,
// excepción "plata y stock/caja": tests primero).
//
// Fuente única: mismos documentos que `sales.service.spec.ts` (ver el
// encabezado de ese archivo para el detalle completo). Contrato de
// `SalesService.crearVenta(tx, input)` fijado ahí — no se repite acá.
//
// `sales.service.ts` NO existe todavía (se crea en la Fase 04, otra
// sesión) — este archivo entero debe fallar al compilar por "Cannot find
// module" en el import de `SalesService` de más arriba. Esa es la razón
// correcta de rojo para la Fase 04a, no un error a corregir.
//
// No se abrió ningún archivo de `backend/src/modules/` salvo IMPORT DE
// TIPO de `stock/stock.service.ts` y `cash-registers/cash-register.service.ts`
// (nunca se leyó su contenido), y la ESTRUCTURA MECÁNICA de
// `test/integration/cash-registers.integration.spec.ts` (setup con
// `AppModule` real, creación de usuarios/login por Prisma directo, patrón
// de limpieza en `afterAll` con arrays de ids, patrón de concurrencia con
// `Promise.allSettled` repetido con datos frescos por iteración) como
// convención mecánica del repo — nunca su lógica de negocio.
//
// Diseño: en vez de levantar el servidor HTTP y pegarle con supertest (no
// hay `SalesController`/`SalesModule` todavía — no es parte del alcance de
// T4.1 según el ROADMAP), se instancia `SalesService` directamente y se
// invoca `crearVenta` dentro de una transacción real de Prisma
// (`prisma.$transaction`), tal como lo pide la sección 9 de la spec
// ("Venta completa camino feliz vía llamada directa al servicio con una
// transacción real"). `StockService`, `CashRegisterService` y
// `SettingsService` se resuelven del contenedor de `AppModule` (ya
// existen, ya están conectados a Postgres) — no hace falta conocer sus
// constructores para instanciarlos a mano.

const prisma = new PrismaClient();

describe('sales (integration, T4.1)', () => {
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

  async function createVariant(
    overrides: Partial<{
      precioVenta: string;
      costoActual: string;
      stockActual: number;
    }> = {},
  ): Promise<{ id: number; productId: number }> {
    const product = await prisma.product.create({
      data: { nombre: `Producto test venta ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-VENTA-${randomUUID()}`,
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

  // Mismo motivo que en `cash-registers.integration.spec.ts`: el índice
  // único parcial de sesión ABIERTA bloquea abrir una nueva mientras haya
  // una sin cerrar, y varios tests de acá necesitan arrancar desde "no hay
  // sesión abierta".
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
        email: `sales-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (ventas)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `sales-test-seller-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Seller de prueba (ventas)',
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
    // Una sesión por vez, de punta a punta, antes de pasar a la siguiente:
    // el índice único parcial de sesión ABIERTA (RN-1 de `cash-registers`)
    // no tolera dos sesiones ABIERTA al mismo tiempo, así que reabrir todas
    // en lote antes de borrar (como hacía la primera versión de este
    // archivo) choca contra esa misma constraint. Reabrir es necesario
    // porque el trigger `cash_movements_immutable_after_close` bloquea
    // cualquier escritura —incluido el DELETE de limpieza— sobre
    // `cash_movements` de una sesión CERRADA. Las ventas de esa sesión
    // (`sales.cash_register_session_id`, `ON DELETE RESTRICT`) también
    // tienen que borrarse antes de poder borrar la sesión misma — se
    // buscan por `cashRegisterSessionId` en vez de filtrar
    // `createdSaleIds` a mano, para no tener que mantener un mapeo
    // venta→sesión aparte.
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

  describe('SalesService.crearVenta — camino feliz', () => {
    it('venta con pago mixto (efectivo + tarjeta): sales, sale_items, payments, stock_movements y cash_movements quedan coherentes entre sí', async () => {
      const variant = await createVariant({
        precioVenta: '300.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          items: [{ variantId: variant.id, cantidad: 2 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('200.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_DEBITO,
              monto: new Prisma.Decimal('400.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true, payments: true },
      });
      expect(dbSale.total.toString()).toBe('600');
      expect(dbSale.subtotal.toString()).toBe('600');
      expect(dbSale.descuentoTotal.toString()).toBe('0');
      expect(dbSale.cashRegisterSessionId).toBe(session.id);
      expect(dbSale.items).toHaveLength(1);
      expect(dbSale.items[0].netoLinea.toString()).toBe('600');
      expect(dbSale.payments).toHaveLength(2);

      const stockMovs = await prisma.stockMovement.findMany({
        where: {
          referenciaTipo: StockMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(stockMovs).toHaveLength(1);
      expect(stockMovs[0].tipo).toBe(StockMovementTipo.VENTA);
      expect(stockMovs[0].delta).toBe(-2);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(8);

      const cashMovs = await prisma.cashMovement.findMany({
        where: {
          sessionId: session.id,
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(cashMovs).toHaveLength(1);
      expect(cashMovs[0].tipo).toBe(CashMovementTipo.VENTA);
      expect(cashMovs[0].monto.toString()).toBe('200');
    });

    it('venta 100% tarjeta: no genera ninguna fila en cash_movements (invariante 7)', async () => {
      const variant = await createVariant({
        precioVenta: '150.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);

      const cashMovs = await prisma.cashMovement.findMany({
        where: { sessionId: session.id },
      });
      expect(cashMovs).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(4);
    });

    it('dos líneas de la misma variante (RN-7): descuenta la suma real de stock, con un stock_movement por línea', async () => {
      const variant = await createVariant({
        precioVenta: '50.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId);

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, {
          userId: ownerId,
          esOwner: true,
          items: [
            { variantId: variant.id, cantidad: 3 },
            { variantId: variant.id, cantidad: 4 },
          ],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('350.00'),
            },
          ],
        }),
      );
      createdSaleIds.push(sale.id);
      void session;

      const stockMovs = await prisma.stockMovement.findMany({
        where: {
          referenciaTipo: StockMovementReferenciaTipo.SALE,
          referenciaId: sale.id,
        },
      });
      expect(stockMovs).toHaveLength(2);
      const deltas = stockMovs.map((m) => m.delta).sort((a, b) => a - b);
      expect(deltas).toEqual([-4, -3]);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(3);
    });
  });

  describe('SalesService.crearVenta — rechazos con rollback completo', () => {
    it('stock insuficiente: rechaza y no escribe nada en sales/sale_items/payments/stock_movements/cash_movements', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 2,
      });
      const session = await openSession(ownerId);

      await expect(
        prisma.$transaction((tx) =>
          salesService.crearVenta(tx, {
            userId: ownerId,
            esOwner: true,
            items: [{ variantId: variant.id, cantidad: 3 }],
            payments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('300.00'),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/insuficiente/i);

      const sales = await prisma.sale.findMany({
        where: { cashRegisterSessionId: session.id },
      });
      expect(sales).toHaveLength(0);

      const stockMovs = await prisma.stockMovement.findMany({
        where: { variantId: variant.id },
      });
      expect(stockMovs).toHaveLength(0);

      const cashMovs = await prisma.cashMovement.findMany({
        where: { sessionId: session.id },
      });
      expect(cashMovs).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(2);
    });

    it('SUM(payments) != total: rechaza (invariante 3) y no escribe nada', async () => {
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
            items: [{ variantId: variant.id, cantidad: 1 }],
            payments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('50.00'),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/no cubren|total/i);

      const sales = await prisma.sale.findMany({
        where: { cashRegisterSessionId: session.id },
      });
      expect(sales).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(10);
    });

    it('sin sesión de caja abierta: rechaza y no escribe nada', async () => {
      await closeAnyOpenSessionDirect();
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });

      await expect(
        prisma.$transaction((tx) =>
          salesService.crearVenta(tx, {
            userId: ownerId,
            esOwner: true,
            items: [{ variantId: variant.id, cantidad: 1 }],
            payments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/sesi[oó]n.*abiert/i);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(10);
    });
  });

  // T4.9 explícito en el ROADMAP. Repetido varias veces con una variante
  // fresca por iteración — la ventana real de la carrera es angosta, una
  // sola vuelta podría no alcanzar a exponer una regresión del lock (mismo
  // motivo que el test de concurrencia de T2.4 y el de T3.2/T3.4).
  describe('T4.9 — concurrencia: dos ventas simultáneas por la última unidad de la misma variante', () => {
    it('una gana, la otra rechaza por stock insuficiente — nunca las dos pasan', async () => {
      const session = await openSession(ownerId, '1000.00');
      void session;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const variant = await createVariant({
          precioVenta: '50.00',
          stockActual: 1,
        });

        const [a, b] = await Promise.allSettled([
          prisma.$transaction((tx) =>
            salesService.crearVenta(tx, {
              userId: ownerId,
              esOwner: true,
              items: [{ variantId: variant.id, cantidad: 1 }],
              payments: [
                {
                  metodo: PaymentMetodo.EFECTIVO,
                  monto: new Prisma.Decimal('50.00'),
                },
              ],
            }),
          ),
          prisma.$transaction((tx) =>
            salesService.crearVenta(tx, {
              userId: sellerId,
              esOwner: false,
              items: [{ variantId: variant.id, cantidad: 1 }],
              payments: [
                {
                  metodo: PaymentMetodo.EFECTIVO,
                  monto: new Prisma.Decimal('50.00'),
                },
              ],
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

        // Nunca las dos pasan, y nunca las dos rechazan (había 1 unidad,
        // alguna de las dos tiene que poder venderla).
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect((rejected[0].reason as Error).message).toMatch(/insuficiente/i);

        createdSaleIds.push(fulfilled[0].value.id);

        const finalVariant = await prisma.variant.findUniqueOrThrow({
          where: { id: variant.id },
        });
        expect(finalVariant.stockActual).toBe(0);

        const stockMovs = await prisma.stockMovement.findMany({
          where: { variantId: variant.id },
        });
        expect(stockMovs).toHaveLength(1);
      }
    });
  });

  // Hallazgo real de la sección 5 de la spec: el lock de la sesión de caja
  // se toma siempre en el paso 1, no solo cuando hay pago en efectivo —
  // este test ejercita esa ventana bajo carrera real, mismo patrón que el
  // test de concurrencia movimiento-vs-cierre de `cash-registers` (fase 07).
  describe('Concurrencia del lock temprano de sesión de caja (hallazgo sección 5 de la spec)', () => {
    it('una venta sin ningún pago en efectivo y un cierre de caja simultáneos: la venta nunca queda registrada contra una sesión ya CERRADA', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const variant = await createVariant({
          precioVenta: '80.00',
          stockActual: 10,
        });
        const session = await openSession(ownerId, '100.00');

        const [ventaResult, cierreResult] = await Promise.allSettled([
          prisma.$transaction((tx) =>
            salesService.crearVenta(tx, {
              userId: ownerId,
              esOwner: true,
              items: [{ variantId: variant.id, cantidad: 1 }],
              payments: [
                {
                  metodo: PaymentMetodo.TARJETA_CREDITO,
                  monto: new Prisma.Decimal('80.00'),
                },
              ],
            }),
          ),
          prisma.$transaction((tx) =>
            cashRegisterService.cerrarSesion(tx, {
              sessionId: session.id,
              montoDeclarado: new Prisma.Decimal('100.00'),
              userId: ownerId,
              esOwner: true,
            }),
          ),
        ]);

        // El cierre es la única operación "de caja" en esta carrera (la
        // venta no toca cash_movements, es 100% tarjeta) — nada debería
        // impedir que el cierre en sí mismo termine bien.
        expect(cierreResult.status).toBe('fulfilled');

        const finalSession = await prisma.cashRegisterSession.findUniqueOrThrow(
          { where: { id: session.id } },
        );
        expect(finalSession.estado).toBe(CashRegisterSessionEstado.CERRADA);

        const salesInSession = await prisma.sale.findMany({
          where: { cashRegisterSessionId: session.id },
        });

        if (ventaResult.status === 'fulfilled') {
          // La venta alcanzó a tomar el lock de sesión antes que el
          // cierre: queda registrada contra la sesión (que en ese
          // instante todavía estaba ABIERTA) sin problema.
          expect(salesInSession).toHaveLength(1);
          createdSaleIds.push(salesInSession[0].id);
        } else {
          // El cierre ganó el lock primero: la venta, al tomarlo después,
          // tiene que ver la sesión ya CERRADA y rechazarse — nunca queda
          // una venta escrita contra una sesión que ya terminó.
          expect(salesInSession).toHaveLength(0);
          expect((ventaResult.reason as Error).message).toMatch(
            /sesi[oó]n.*abiert|cerrada/i,
          );
        }
      }
    });
  });
});
