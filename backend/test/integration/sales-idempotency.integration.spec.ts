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
import { withIdempotency } from '../../src/common/idempotency/idempotency.util';

// Fase 04a — T4.5 ("Aplicar el interceptor de idempotencia a la venta"),
// tests de integración contra Postgres real (nunca mockeado, BLUEPRINT
// §9.8). Sesión aislada: no se abrió `sales.service.ts`.
//
// Alcance real de T4.5, ya decidido de antemano (no reinterpretado acá,
// ver `ROADMAP.md` T4.5 y `BLUEPRINT.md` §9.7/AD-10 sección 2,
// `state/reports/modulo-sales-spec.md` RN-9): `sales` no tiene
// `SalesController` ni módulo Nest todavía (T4.1-T4.4 construyeron
// únicamente `SalesService` — los controllers son T4.10/T4.11), así que
// no existe ninguna ruta HTTP donde aplicar `IdempotencyInterceptor` /
// `@IdempotencyKey()` de verdad. Este archivo NO registra ningún
// controller ni prueba esas piezas contra una ruta HTTP de `sales` — eso
// no es parte de este ticket.
//
// Lo que este archivo prueba, empíricamente, es que el mecanismo YA
// FUNCIONA de punta a punta aunque el controller no exista todavía:
// envolviendo manualmente, igual que lo haría el futuro controller, la
// llamada completa (`prisma.$transaction((tx) => salesService.crearVenta(tx,
// input))`) con `withIdempotency(write, findExisting)` — mismo patrón que
// `idempotency.integration.spec.ts` (T0.14) usó con `expenses`, y mismo
// patrón de "doble click" (`Idempotency-Key` repetida) que
// `cash-registers.integration.spec.ts` prueba a nivel HTTP para T3.3 (acá
// no hay HTTP, se arma directo en el test).
//
// Contrato de `crearVenta` ampliado con `idempotencyKey: string`
// obligatorio (decisión de esta sesión, no de `sales.service.ts` que no
// se abrió): se pasa a través de una variable con un tipo explícito más
// ancho (`CrearVentaInputT45`, no un objeto literal inline) para que la
// propiedad nueva no dispare "excess property" de TypeScript contra el
// tipo real (todavía angosto) del parámetro — el rojo que produce es de
// aserción (la clave no se persiste, por lo tanto no hay deduplicación
// real todavía), no de compilación.
//
// Estructura mecánica (setup con `AppModule` real, helpers
// `createVariant`/`openSession`/`closeAnyOpenSessionDirect`, patrón de
// limpieza en `afterAll`) copiada de `sales.integration.spec.ts` (T4.1,
// mismo módulo, ya autorizado como tooling de test) — no se leyó ninguna
// lógica de negocio nueva ahí, solo la convención mecánica del repo.

const prisma = new PrismaClient();

interface CrearVentaInputT45 {
  userId: number;
  esOwner: boolean;
  items: Array<{ variantId: number; cantidad: number }>;
  payments: Array<{
    metodo: PaymentMetodo;
    monto: Prisma.Decimal.Value;
    referencia?: string;
  }>;
  idempotencyKey: string;
}

describe('sales — idempotencia (integration, T4.5)', () => {
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
      data: { nombre: `Producto test idempotencia ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-IDEM-${randomUUID()}`,
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

  // Mismo motivo que `sales.integration.spec.ts`: el índice único parcial
  // de sesión ABIERTA bloquea abrir una nueva mientras haya una sin
  // cerrar.
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
        email: `sales-idem-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (idempotencia de ventas)',
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
    // Una sesión por vez, de punta a punta (mismo motivo que
    // `sales.integration.spec.ts`: el trigger de inmutabilidad de
    // `cash_movements` bloquea el DELETE de limpieza sobre una sesión
    // CERRADA).
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

  // Mismo patrón que `withIdempotency` usa en `idempotency.integration.spec.ts`
  // (T0.14) con `expenses`: `write` abre la transacción real y llama al
  // servicio; `findExisting` busca por la clave si `write` choca contra el
  // índice único. Esto es exactamente lo que haría el futuro
  // `SalesController` (T4.10/T4.11) — armado acá porque no existe todavía.
  function crearVentaConIdempotencia(input: CrearVentaInputT45): Promise<Sale> {
    return withIdempotency(
      () => prisma.$transaction((tx) => salesService.crearVenta(tx, input)),
      () =>
        prisma.sale.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        }),
    );
  }

  describe('mismo Idempotency-Key, dos llamadas SECUENCIALES (RN-9, BLUEPRINT §9.7)', () => {
    it('la segunda devuelve la MISMA venta que la primera, sin crear una segunda fila en sales/sale_items/payments/stock_movements/cash_movements', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId);
      const key = randomUUID();
      const input: CrearVentaInputT45 = {
        userId: ownerId,
        esOwner: true,
        idempotencyKey: key,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      };

      const first = await crearVentaConIdempotencia(input);
      createdSaleIds.push(first.id);
      const second = await crearVentaConIdempotencia(input);

      expect(second.id).toBe(first.id);

      const salesCount = await prisma.sale.count({
        where: { idempotencyKey: key },
      });
      expect(salesCount).toBe(1);

      const salesInSession = await prisma.sale.count({
        where: { cashRegisterSessionId: session.id },
      });
      expect(salesInSession).toBe(1);

      const stockMovs = await prisma.stockMovement.count({
        where: {
          referenciaTipo: StockMovementReferenciaTipo.SALE,
          variantId: variant.id,
        },
      });
      expect(stockMovs).toBe(1);

      const cashMovs = await prisma.cashMovement.count({
        where: {
          sessionId: session.id,
          referenciaTipo: CashMovementReferenciaTipo.SALE,
        },
      });
      expect(cashMovs).toBe(1);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      // Si de verdad se dedupe, el stock solo se descontó una vez.
      expect(variantAfter.stockActual).toBe(9);
    });
  });

  describe('mismo Idempotency-Key, dos llamadas DISPARADAS EN SIMULTÁNEO (doble click real, BLUEPRINT §9.7)', () => {
    it('nunca quedan dos filas en sales con la misma clave — las dos llamadas terminan devolviendo la misma venta', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const variant = await createVariant({
          precioVenta: '80.00',
          stockActual: 10,
        });
        const session = await openSession(ownerId);
        const key = randomUUID();
        const input: CrearVentaInputT45 = {
          userId: ownerId,
          esOwner: true,
          idempotencyKey: key,
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('80.00'),
            },
          ],
        };

        const [a, b] = await Promise.allSettled([
          crearVentaConIdempotencia(input),
          crearVentaConIdempotencia(input),
        ]);

        const fulfilled = [a, b].filter(
          (r): r is PromiseFulfilledResult<Sale> => r.status === 'fulfilled',
        );

        // El mecanismo de idempotencia (T0.14, ya VERDE) garantiza que
        // ninguna de las dos llamadas debería rechazarse por la carrera en
        // sí — una gana la escritura, la otra recibe la fila existente.
        expect(fulfilled).toHaveLength(2);
        expect(fulfilled[0].value.id).toBe(fulfilled[1].value.id);
        createdSaleIds.push(fulfilled[0].value.id);

        const salesCount = await prisma.sale.count({
          where: { idempotencyKey: key },
        });
        expect(salesCount).toBe(1);

        const salesInSession = await prisma.sale.count({
          where: { cashRegisterSessionId: session.id },
        });
        expect(salesInSession).toBe(1);

        await closeAnyOpenSessionDirect();
      }
    });
  });

  describe('Idempotency-Key DISTINTA en cada llamada → dos ventas distintas, sin interferencia', () => {
    it('cada venta persiste su propia clave, ninguna se pisa con la otra', async () => {
      const variant = await createVariant({
        precioVenta: '50.00',
        stockActual: 10,
      });
      const session = await openSession(ownerId);
      void session;
      const key1 = randomUUID();
      const key2 = randomUUID();

      const first = await crearVentaConIdempotencia({
        userId: ownerId,
        esOwner: true,
        idempotencyKey: key1,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('50.00'),
          },
        ],
      });
      createdSaleIds.push(first.id);

      const second = await crearVentaConIdempotencia({
        userId: ownerId,
        esOwner: true,
        idempotencyKey: key2,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('50.00'),
          },
        ],
      });
      createdSaleIds.push(second.id);

      expect(first.id).not.toBe(second.id);

      const saleFirst = await prisma.sale.findUniqueOrThrow({
        where: { id: first.id },
      });
      const saleSecond = await prisma.sale.findUniqueOrThrow({
        where: { id: second.id },
      });
      expect(saleFirst.idempotencyKey).toBe(key1);
      expect(saleSecond.idempotencyKey).toBe(key2);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(8);
    });
  });

  // Defensa en profundidad, sin pasar por `withIdempotency` ni por
  // `crearVenta` — ejercita el índice único de base directo, sorteando el
  // servicio (mismo criterio que otros tests de este proyecto para
  // constraints reales, p.ej. `schema-constraints.integration.spec.ts`).
  // A diferencia de los tests de arriba, este NO depende de que T4.5 esté
  // implementado — el índice único ya existe desde la fase 01 — así que
  // pasa contra la base actual sin cambios; queda como regresión
  // permanente, no como caso rojo de este ticket.
  describe('constraint de base ejercitada directo (índice único de sales.idempotency_key)', () => {
    it('una segunda fila en sales con la misma idempotency_key, insertada directo por Prisma, es rechazada por la base', async () => {
      const session = await openSession(ownerId);
      const key = randomUUID();

      const sale1 = await prisma.sale.create({
        data: {
          fecha: new Date(),
          userId: ownerId,
          cashRegisterSessionId: session.id,
          subtotal: new Prisma.Decimal('10.00'),
          descuentoTotal: new Prisma.Decimal('0.00'),
          total: new Prisma.Decimal('10.00'),
          idempotencyKey: key,
        },
      });
      createdSaleIds.push(sale1.id);

      await expect(
        prisma.sale.create({
          data: {
            fecha: new Date(),
            userId: ownerId,
            cashRegisterSessionId: session.id,
            subtotal: new Prisma.Decimal('10.00'),
            descuentoTotal: new Prisma.Decimal('0.00'),
            total: new Prisma.Decimal('10.00'),
            idempotencyKey: key,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });

      const count = await prisma.sale.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });

    it('dos filas en sales con idempotency_key NULL (sin clave) no chocan entre sí — la constraint es solo sobre valores no nulos', async () => {
      const session = await openSession(ownerId);

      const sale1 = await prisma.sale.create({
        data: {
          fecha: new Date(),
          userId: ownerId,
          cashRegisterSessionId: session.id,
          subtotal: new Prisma.Decimal('10.00'),
          descuentoTotal: new Prisma.Decimal('0.00'),
          total: new Prisma.Decimal('10.00'),
        },
      });
      createdSaleIds.push(sale1.id);

      const sale2 = await prisma.sale.create({
        data: {
          fecha: new Date(),
          userId: ownerId,
          cashRegisterSessionId: session.id,
          subtotal: new Prisma.Decimal('10.00'),
          descuentoTotal: new Prisma.Decimal('0.00'),
          total: new Prisma.Decimal('10.00'),
        },
      });
      createdSaleIds.push(sale2.id);

      expect(sale1.idempotencyKey).toBeNull();
      expect(sale2.idempotencyKey).toBeNull();
    });
  });
});
