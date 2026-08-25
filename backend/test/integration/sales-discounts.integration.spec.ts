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
import { applyPercentage, prorate } from '../../src/common/money/money.util';

// Fase 04a (T4.3) — tests de integración escritos ANTES de la
// implementación de descuentos, contra Postgres real (nunca mockeado,
// BLUEPRINT §9.8, excepción "plata y stock/caja": tests primero, sesión
// aislada de la que implementa).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` T4.3 y la nota en
// prosa "Alcance de T4.3 achicado a propósito (2026-08-25)" debajo de la
// tabla de Etapa 4; `BLUEPRINT.md` §5.3 (descuentos), AD-18 (prorrateo,
// sección 2), §9.3 (redondeo/prorrateo, los 2 tests obligatorios), §6
// invariantes 4 y 12; `state/reports/modulo-sales-spec.md` RN-4 y RN-5;
// `state/AMBIGUITIES.md` AMB-14 (incluida la nota "Construcción diferida
// (2026-08-25)"); `backend/prisma/schema.prisma` modelo `SaleDiscount` y
// enum `SaleDiscountTipo`. NO se abrió `sales.service.ts`.
//
// No se abrió ningún archivo de `backend/src/modules/` salvo IMPORT DE
// TIPO (nunca contenido) de `stock/stock.service.ts` y
// `cash-registers/cash-register.service.ts`, y se reusa/extiende la
// ESTRUCTURA MECÁNICA (nunca la lógica de negocio) de
// `test/integration/sales.integration.spec.ts` — mismo patrón de setup
// (`AppModule` real, usuarios OWNER/SELLER por Prisma directo,
// `createVariant`/`openSession`/`closeAnyOpenSessionDirect`, limpieza en
// `afterAll` con arrays de ids) — extendido acá para además limpiar
// `sale_discounts` (tabla nueva para este módulo, `ON DELETE RESTRICT`
// hacia `sales` según `schema.prisma`, así que tiene que borrarse antes que
// la venta, igual que `payments`/`sale_items`).
//
// Setting `max_descuento_vendedor_pct` NO se siembra acá a mano: ya está
// sembrado en 10 desde T0.13 (`prisma/seed.ts`, confirmado contra la base
// de test antes de escribir este archivo) — mismo criterio que
// `permitir_venta_sin_stock` en `sales.integration.spec.ts`, que tampoco lo
// siembra.
//
// Contrato ampliado de `crearVenta(tx, input)` (mismo que
// `sales.service.spec.ts`, no se repite la justificación acá): `discounts?:
// Array<{descripcion, porcentaje?, monto}>` y `esOwner: boolean`
// (obligatorio). Se pasa siempre a través de una variable con un tipo
// explícito más ancho (`CrearVentaInputT43`), nunca como objeto literal
// inline, para que la propiedad extra no dispare un error de compilación
// de TypeScript contra el tipo real (todavía angosto) — el rojo esperado
// acá es de aserción/runtime, no de compilación.

const prisma = new PrismaClient();

interface DiscountInputT43 {
  descripcion: string;
  porcentaje?: Prisma.Decimal.Value;
  monto?: Prisma.Decimal.Value;
}

interface CrearVentaInputT43 {
  userId: number;
  items: Array<{ variantId: number; cantidad: number }>;
  payments: Array<{
    metodo: PaymentMetodo;
    monto: Prisma.Decimal.Value;
    referencia?: string;
  }>;
  discounts?: DiscountInputT43[];
  esOwner: boolean;
}

describe('sales — descuentos (integration, T4.3)', () => {
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
      data: { nombre: `Producto test descuento ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `SKU-DESC-${randomUUID()}`,
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

  // Mismo motivo que en `sales.integration.spec.ts`: el índice único
  // parcial de sesión ABIERTA bloquea abrir una nueva mientras haya una sin
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
        email: `sales-desc-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (descuentos)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `sales-desc-test-seller-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Seller de prueba (descuentos)',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    sellerId = seller.id;
    createdUserIds.push(seller.id);
    void sellerId;
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
        // `sale_discounts` — nuevo para T4.3, mismo criterio que
        // `payments`/`sale_items`: FK `ON DELETE RESTRICT` hacia `sales`,
        // tiene que borrarse antes que la venta.
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

  describe('camino feliz — descuento manual dentro del tope', () => {
    it('esOwner: true: sale_discounts queda con tipo MANUAL, descripcion, monto, sin porcentaje, autorizado_por_user_id null', async () => {
      const variant = await createVariant({
        precioVenta: '500.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: true,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('450.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento manual de prueba',
            monto: new Prisma.Decimal('50.00'),
          },
        ],
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { discounts: true, items: true },
      });
      expect(dbSale.descuentoTotal.toString()).toBe('50');
      expect(dbSale.total.toString()).toBe('450');
      expect(dbSale.discounts).toHaveLength(1);
      const discount = dbSale.discounts[0];
      expect(discount.tipo).toBe('MANUAL');
      expect(discount.descripcion).toBe('Descuento manual de prueba');
      expect(discount.monto.toString()).toBe('50');
      expect(discount.porcentaje).toBeNull();
      expect(discount.autorizadoPorUserId).toBeNull();
    });

    it('esOwner: false, dentro del tope: mismo resultado, autorizado_por_user_id también null', async () => {
      const variant = await createVariant({
        precioVenta: '500.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: false,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('475.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento manual chico',
            monto: new Prisma.Decimal('25.00'),
          },
        ],
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { discounts: true },
      });
      expect(dbSale.discounts).toHaveLength(1);
      expect(dbSale.discounts[0].autorizadoPorUserId).toBeNull();
    });

    it('descuento cargado como porcentaje: el monto persistido coincide con applyPercentage(subtotal, porcentaje)', async () => {
      const variant = await createVariant({
        precioVenta: '333.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      const montoEsperado = applyPercentage('333.00', '10');

      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: false,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('333.00').minus(montoEsperado),
          },
        ],
        discounts: [
          {
            descripcion: 'Promo 10%',
            porcentaje: new Prisma.Decimal('10'),
          },
        ],
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { discounts: true },
      });
      expect(dbSale.discounts[0].monto.toString()).toBe(
        montoEsperado.toString(),
      );
      expect(dbSale.discounts[0].porcentaje?.toString()).toBe('10');
    });
  });

  describe('tope duro (invariante 4) — 0 ≤ descuento_total ≤ subtotal, cualquier rol', () => {
    it('descuento_total > subtotal: rechaza y no escribe nada en sales/sale_discounts/payments/stock_movements/cash_movements', async () => {
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      // El pago cubre el SUBTOTAL (100), no el total post-descuento (que
      // acá sería negativo e imposible). Deliberado: si el rechazo se
      // verificara con un pago que ya no coincide con lo que la
      // implementación actual (que todavía ignora `discounts` por
      // completo) calcula como total, el test pasaría igual hoy por un
      // motivo ajeno (invariante 3, pagos no cubren el total) — un rojo
      // "de casualidad" que no prueba nada del tope duro. Con el pago
      // igual al subtotal, la implementación de hoy directamente
      // *aceptaría* la venta (mal, según la regla de negocio) — el
      // rechazo solo puede venir de una validación real del tope duro que
      // todavía no existe.
      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: true, // el tope duro no depende del rol
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento excesivo',
            monto: new Prisma.Decimal('150.00'),
          },
        ],
      };

      await expect(
        prisma.$transaction((tx) => salesService.crearVenta(tx, input)),
      ).rejects.toThrow(/subtotal/i);

      const sales = await prisma.sale.findMany({
        where: { cashRegisterSessionId: session.id },
      });
      expect(sales).toHaveLength(0);

      const discounts = await prisma.saleDiscount.findMany({
        where: { sale: { cashRegisterSessionId: session.id } },
      });
      expect(discounts).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(5);

      const cashMovs = await prisma.cashMovement.findMany({
        where: { sessionId: session.id },
      });
      expect(cashMovs).toHaveLength(0);
    });
  });

  describe('tope del vendedor (max_descuento_vendedor_pct, sembrado en 10) — solo si esOwner === false', () => {
    it('esOwner: false, 8% con tope 10%: pasa sin problema', async () => {
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      const monto = applyPercentage('1000.00', '8');

      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: false,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1000.00').minus(monto),
          },
        ],
        discounts: [{ descripcion: 'Promo 8%', porcentaje: '8', monto }],
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.descuentoTotal.toString()).toBe(monto.toString());
    });

    it('esOwner: false, 15% con tope 10%: rechaza, sin mecanismo de autorización (AMB-14 diferida), sin escribir nada', async () => {
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      const monto = applyPercentage('1000.00', '15');

      // Igual que en el test del tope duro: el pago cubre el SUBTOTAL
      // (1000), no el total post-descuento — con la implementación de hoy
      // (que ignora `discounts`), esto se ACEPTARÍA sin problema. El
      // rechazo solo puede venir de una validación real del tope del
      // vendedor, que todavía no existe.
      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: false,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1000.00'),
          },
        ],
        discounts: [{ descripcion: 'Promo 15%', porcentaje: '15', monto }],
      };

      await expect(
        prisma.$transaction((tx) => salesService.crearVenta(tx, input)),
      ).rejects.toThrow(/l[ií]mite.*vendedor|vendedor.*l[ií]mite/i);

      const sales = await prisma.sale.findMany({
        where: { cashRegisterSessionId: session.id },
      });
      expect(sales).toHaveLength(0);

      const variantAfter = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfter.stockActual).toBe(5);
    });

    it('esOwner: true, 50% (muy por encima del tope del vendedor): pasa igual, sin exigir nada', async () => {
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);
      const monto = applyPercentage('1000.00', '50');

      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: true,
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('1000.00').minus(monto),
          },
        ],
        discounts: [
          { descripcion: 'Descuento de la dueña', porcentaje: '50', monto },
        ],
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(dbSale.total.toString()).toBe('500');
    });
  });

  describe('prorrateo real a las líneas (AD-18, RN-5) y BLUEPRINT §9.3 — tests obligatorios, flujo completo con Postgres real', () => {
    it('test obligatorio #2: 3 líneas reales, descuento que deja residuo naïve — SUM(sale_items.neto_linea) == sales.total exacto', async () => {
      // Mismos números que el ejemplo de BLUEPRINT §9.3: subtotal =
      // 10.00 + 10.00 + 10.01 = 30.01; descuento manual 3.01; total = 27.00.
      const v1 = await createVariant({ precioVenta: '10.00', stockActual: 5 });
      const v2 = await createVariant({ precioVenta: '10.00', stockActual: 5 });
      const v3 = await createVariant({ precioVenta: '10.01', stockActual: 5 });
      const session = await openSession(ownerId);

      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: true, // evita cualquier interacción con el tope del vendedor
        items: [
          { variantId: v1.id, cantidad: 1 },
          { variantId: v2.id, cantidad: 1 },
          { variantId: v3.id, cantidad: 1 },
        ],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('27.00'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento variado',
            monto: new Prisma.Decimal('3.01'),
          },
        ],
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: { orderBy: { id: 'asc' } } },
      });
      expect(dbSale.subtotal.toString()).toBe('30.01');
      expect(dbSale.descuentoTotal.toString()).toBe('3.01');
      expect(dbSale.total.toString()).toBe('27');

      const sumSubtotal = dbSale.items.reduce(
        (sum, item) => sum.plus(item.subtotal),
        new Prisma.Decimal(0),
      );
      expect(sumSubtotal.toString()).toBe(dbSale.subtotal.toString());

      const sumNetoLinea = dbSale.items.reduce(
        (sum, item) => sum.plus(item.netoLinea),
        new Prisma.Decimal(0),
      );
      expect(sumNetoLinea.toFixed(2)).toBe('27.00');
      expect(sumNetoLinea.toString()).toBe(dbSale.total.toString());

      const expectedNetos = prorate(['10.00', '10.00', '10.01'], '27.00').map(
        (n) => n.toFixed(2),
      );
      const actualNetos = dbSale.items.map((item) => item.netoLinea.toFixed(2));
      expect(actualNetos).toEqual(expectedNetos);
    });

    it('test obligatorio #1: 15% de descuento sobre $2.999 da un total de $2.549,15, persistido en la venta completa', async () => {
      const variant = await createVariant({
        precioVenta: '2999.00',
        stockActual: 5,
      });
      const session = await openSession(ownerId);

      const input: CrearVentaInputT43 = {
        userId: ownerId,
        esOwner: true, // 15% > tope del 10% del vendedor
        items: [{ variantId: variant.id, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('2549.15'),
          },
        ],
        discounts: [
          {
            descripcion: 'Descuento 15%',
            porcentaje: new Prisma.Decimal('15'),
          },
        ],
      };

      const sale = await prisma.$transaction((tx) =>
        salesService.crearVenta(tx, input),
      );
      createdSaleIds.push(sale.id);
      void session;

      const dbSale = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
        include: { items: true, discounts: true },
      });
      expect(dbSale.subtotal.toString()).toBe('2999');
      expect(dbSale.descuentoTotal.toString()).toBe('449.85');
      expect(dbSale.total.toString()).toBe('2549.15');
      expect(dbSale.items[0].netoLinea.toString()).toBe('2549.15');
      expect(dbSale.discounts[0].monto.toString()).toBe('449.85');
    });
  });
});
