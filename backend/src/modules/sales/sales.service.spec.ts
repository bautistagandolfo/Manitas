import { Prisma, PaymentMetodo } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StockService } from '../stock/stock.service';
import type { CashRegisterService } from '../cash-registers/cash-register.service';
import type { SettingsService } from '../../common/settings/settings.service';
import { lineSubtotal } from '../../common/money/money.util';
import { SalesService } from './sales.service';

// Fase 04a (T4.1) — tests escritos ANTES de la implementación, contra Prisma
// completamente mockeado (BLUEPRINT §9.8, excepción "plata y stock/caja":
// los tests se escriben primero, derivados de la especificación, y se
// verifica que fallen antes de implementar).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` (T4.1, Etapa 4 y sus
// notas de hallazgos técnicos de la fase 06), `BLUEPRINT.md` (AD-3/4/5/8/9/
// 10/14/18/19, §3.4, §5.3, invariantes 3/4/5/6/7/9/10/12/13/15, §7, §9.3,
// §9.4, §9.7) y `docs/build-protocol/state/reports/modulo-sales-spec.md`
// (RN-1 a RN-10, secciones 3, 4.2, 4.3, 5, 6, 9). No se abrió ningún archivo
// de `backend/src/modules/` salvo `stock/stock.service.ts` y
// `cash-registers/cash-register.service.ts` como IMPORT DE TIPO (nunca se
// leyó su contenido) para poder tipar el constructor de `SalesService`, y
// la ESTRUCTURA (no la lógica) de `cash-registers/cash-register.service.spec.ts`
// como convención mecánica del repo (patrón MockTx/asTx, jest.fn tipados).
//
// ─── Contrato de `SalesService`, definido en esta sesión (no existe
// todavía ni la clase ni el archivo real) ───────────────────────────────
//
// Nombre de clase: `SalesService`. Constructor:
//   (prisma: PrismaService, stockService: StockService,
//    cashRegisterService: CashRegisterService, settingsService: SettingsService)
// — mismo criterio que el resto de los servicios de negocio (inyecta sus
// colaboradores, nunca abre su propia transacción salvo que el ticket lo
// pida explícitamente, cosa que T4.1 no pide).
//
// Método principal: `crearVenta(tx, input)`, donde:
//   input = {
//     userId: number;
//     items: Array<{ variantId: number; cantidad: number }>;
//     payments: Array<{ metodo: PaymentMetodo; monto: Decimal.Value; referencia?: string }>;
//   }
// Sin `discounts` (T4.3) ni `ajusteRedondeo` explícito (T4.6) todavía — para
// T4.1, `descuento_total = 0` y `ajuste_redondeo = 0` son fijos, lo que hace
// que `neto_linea = subtotal_linea` y `neto_unitario = precio_unitario` por
// línea coincidan exactamente con lo que el prorrateo general daría en este
// caso particular (total == subtotal, sin residuo) — no se reimplementa el
// prorrateo general acá, queda para cuando haya descuento/ajuste real.
//
// Flujo esperado (RN-1 + hallazgos de la sección 5 de la spec), todo con el
// `tx` recibido, nunca abriendo transacción propia:
//   1. `cashRegisterService.getSesionAbiertaOrThrow(tx)` — lectura fail-fast,
//      404/409 "No hay una sesión de caja abierta" si no hay ninguna.
//   2. Lock explícito de esa fila de sesión, SIEMPRE (hallazgo de la
//      sección 5: el lock temprano de caja no depende de si hay pago en
//      efectivo): `tx.$queryRaw` con `SELECT id FROM cash_register_sessions
//      WHERE id = ${sesion.id} FOR UPDATE`.
//   3. Agregar cantidad pedida por `variantId` (RN-7, sumando todas las
//      líneas de la misma variante).
//   4. Lock de las variantes involucradas, ordenado por id, patrón exacto
//      de BLUEPRINT §9.4: `tx.$queryRaw` con `SELECT id FROM variants WHERE
//      id IN (${Prisma.join(idsOrdenados)}) ORDER BY id FOR UPDATE`.
//   5. `tx.variant.findMany` para leer `precioVenta`/`costoActual`/
//      `stockActual` de esas variantes (recién ahora, con el lock tomado).
//   6. Validar stock agregado por variante contra `stockActual`, salvo
//      `settingsService.getBool('permitir_venta_sin_stock')`.
//   7. Calcular `subtotal_linea` (`lineSubtotal` de `common/money`),
//      `subtotal` = suma; `descuentoTotal = 0`; `ajusteRedondeo = 0`;
//      `total = subtotal`; validar `total >= 0` (defensivo, invariante 4).
//   8. Validar `SUM(payments.monto) == total` (invariante 3) ANTES de
//      escribir nada.
//   9. `tx.sale.create` con `items: { create: [...] }` y
//      `payments: { create: [...] }` anidados en una sola llamada (decisión
//      de esta sesión: no hay ningún cálculo intermedio entre "crear
//      sale+items" y "registrar payments" en T4.1 sin descuentos, así que
//      una sola escritura nested es válida y más simple que dos statements
//      separados — documentado, no adivinado).
//  10. `stockService.descontarPorVenta(tx, { variantId, cantidad, saleId,
//      userId, permitirStockNegativo })` UNA VEZ POR LÍNEA (no una vez por
//      variante agregada — BLUEPRINT §5.3 paso 6 dice "por línea"; la
//      agregación de RN-7 es solo para la validación previa de stock).
//  11. Si `SUM(payments donde metodo === EFECTIVO) > 0`,
//      `cashRegisterService.registrarMovimiento(tx, { sessionId, tipo:
//      'VENTA', monto: sumaEfectivo, referenciaTipo: 'SALE', referenciaId:
//      sale.id, descripcion, userId })` (contrato ya fijado, spec sección
//      4.3, VERDE desde T3.2).
//
// `descripcionSnapshot` (columna NOT NULL): T4.1 tiene que escribir algo
// (la columna no admite null), pero el "congelado formal" completo
// (nombre + talle + color) es nominalmente T4.2 según el propio ticket. Acá
// solo se verifica que quede un string no vacío, sin pinnear su formato
// exacto — decisión de esta sesión para no adelantar el alcance de T4.2.
//
// RN-10 (ocultar `costoUnitario` para SELLER en las respuestas): no se
// prueba acá. El alcance textual de T4.1 (ROADMAP.md, notas de Etapa 4) no
// lo menciona entre lo que este ticket construye — es responsabilidad de
// los endpoints GET/POST de la capa de controller, no de `crearVenta` en
// sí. Se deja fuera a propósito, mismo criterio que "no adelantar tickets
// futuros" (CLAUDE.md regla 10).

interface VariantRow {
  id: number;
  precioVenta: Prisma.Decimal;
  costoActual: Prisma.Decimal;
  stockActual: number;
}

function buildVariantRow(overrides: Partial<VariantRow> = {}): VariantRow {
  return {
    id: 10,
    precioVenta: new Prisma.Decimal('100.00'),
    costoActual: new Prisma.Decimal('60.00'),
    stockActual: 10,
    ...overrides,
  };
}

interface SessionRow {
  id: number;
  estado: 'ABIERTA' | 'CERRADA';
}

function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return { id: 1, estado: 'ABIERTA', ...overrides };
}

interface SaleItemCreateInput {
  variantId: number;
  descripcionSnapshot: string;
  cantidad: number;
  precioUnitario: Prisma.Decimal.Value;
  costoUnitario: Prisma.Decimal.Value;
  subtotal: Prisma.Decimal.Value;
  netoLinea: Prisma.Decimal.Value;
  netoUnitario: Prisma.Decimal.Value;
}

interface PaymentCreateInput {
  metodo: PaymentMetodo;
  monto: Prisma.Decimal.Value;
  referencia?: string | null;
}

interface SaleCreateCall {
  data: {
    fecha: Date;
    userId: number;
    cashRegisterSessionId: number;
    subtotal: Prisma.Decimal.Value;
    descuentoTotal: Prisma.Decimal.Value;
    ajusteRedondeo: Prisma.Decimal.Value;
    total: Prisma.Decimal.Value;
    items: { create: SaleItemCreateInput[] };
    payments: { create: PaymentCreateInput[] };
  };
}

interface CreatedSale {
  id: number;
  numero: number;
  items: Array<SaleItemCreateInput & { id: number }>;
  payments: Array<PaymentCreateInput & { id: number }>;
}

function buildCreatedSaleFromCall(
  call: SaleCreateCall,
  saleId = 501,
): CreatedSale {
  return {
    id: saleId,
    numero: saleId,
    items: call.data.items.create.map((item, index) => ({
      id: index + 1,
      ...item,
    })),
    payments: call.data.payments.create.map((p, index) => ({
      id: index + 1,
      ...p,
    })),
  };
}

interface MockTx {
  variant: {
    findMany: jest.Mock<Promise<VariantRow[]>, [unknown]>;
  };
  sale: {
    create: jest.Mock<Promise<CreatedSale>, [SaleCreateCall]>;
  };
  $queryRaw: jest.Mock;
}

function buildMockTx(variantRows: VariantRow[]): MockTx {
  return {
    variant: {
      findMany: jest
        .fn<Promise<VariantRow[]>, [unknown]>()
        .mockResolvedValue(variantRows),
    },
    sale: {
      create: jest
        .fn<Promise<CreatedSale>, [SaleCreateCall]>()
        .mockImplementation((call) =>
          Promise.resolve(buildCreatedSaleFromCall(call)),
        ),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
}

function asTx(tx: MockTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

interface Deps {
  stockService: { descontarPorVenta: jest.Mock };
  cashRegisterService: {
    getSesionAbiertaOrThrow: jest.Mock;
    registrarMovimiento: jest.Mock;
  };
  settingsService: { getBool: jest.Mock };
}

function buildDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    stockService: {
      descontarPorVenta: jest.fn().mockResolvedValue(undefined),
    },
    cashRegisterService: {
      getSesionAbiertaOrThrow: jest.fn().mockResolvedValue(buildSessionRow()),
      registrarMovimiento: jest.fn().mockResolvedValue({ id: 999 }),
    },
    settingsService: {
      getBool: jest.fn().mockResolvedValue(false),
    },
    ...overrides,
  };
}

function buildService(deps: Deps): SalesService {
  return new SalesService(
    {} as PrismaService,
    deps.stockService as unknown as StockService,
    deps.cashRegisterService as unknown as CashRegisterService,
    deps.settingsService as unknown as SettingsService,
  );
}

function sqlText(call: unknown[]): string {
  return (call[0] as string[]).join('').toLowerCase();
}

describe('SalesService.crearVenta', () => {
  describe('camino feliz (RN-1, RN-2, invariantes 3/7/12)', () => {
    it('una línea, sin descuento, pago único en efectivo: descuenta stock y registra el movimiento de caja correcto', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [{ variantId: 10, cantidad: 2 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('200.00'),
          },
        ],
      });

      expect(result.id).toBe(501);
      expect(tx.sale.create).toHaveBeenCalledTimes(1);
      const call = tx.sale.create.mock.calls[0][0];
      const expectedSubtotal = lineSubtotal(2, variant.precioVenta);
      expect(new Prisma.Decimal(call.data.subtotal).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(new Prisma.Decimal(call.data.descuentoTotal).toString()).toBe('0');
      expect(new Prisma.Decimal(call.data.ajusteRedondeo).toString()).toBe('0');
      expect(new Prisma.Decimal(call.data.total).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(call.data.userId).toBe(7);
      expect(call.data.cashRegisterSessionId).toBe(1);

      // Invariante 12 (la parte que le toca a T4.1, sin descuento/ajuste):
      // subtotal == SUM(sale_items.subtotal) y SUM(neto_linea) == total.
      const item = call.data.items.create[0];
      expect(new Prisma.Decimal(item.subtotal).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(new Prisma.Decimal(item.netoLinea).toString()).toBe(
        expectedSubtotal.toString(),
      );
      expect(new Prisma.Decimal(item.netoUnitario).toString()).toBe(
        variant.precioVenta.toString(),
      );
      expect(item.descripcionSnapshot.length).toBeGreaterThan(0);
      expect(item.precioUnitario.toString()).toBe(
        variant.precioVenta.toString(),
      );
      expect(item.costoUnitario.toString()).toBe(
        variant.costoActual.toString(),
      );

      // Descuenta stock una vez, con los datos correctos (contrato de la
      // spec, sección 4.2: variantId, cantidad, saleId, userId,
      // permitirStockNegativo).
      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledTimes(1);
      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledWith(
        asTx(tx),
        expect.objectContaining({
          variantId: 10,
          cantidad: 2,
          saleId: 501,
          userId: 7,
          permitirStockNegativo: false,
        }),
      );

      // Invariante 7: el único pago es EFECTIVO → un solo movimiento de
      // caja, tipo VENTA, referenciando la venta, por el monto correcto.
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      expect(deps.cashRegisterService.registrarMovimiento).toHaveBeenCalledWith(
        asTx(tx),
        expect.objectContaining({
          sessionId: 1,
          tipo: 'VENTA',
          referenciaTipo: 'SALE',
          referenciaId: 501,
          userId: 7,
        }),
      );
      const movimientoCall = deps.cashRegisterService.registrarMovimiento.mock
        .calls[0][1] as { monto: Prisma.Decimal.Value };
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe(
        expectedSubtotal.toString(),
      );
    });

    it('pago 100% tarjeta: NO llama a registrarMovimiento (invariante 7)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.TARJETA_CREDITO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      });

      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledTimes(1);
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('pago mixto (efectivo + tarjeta): el movimiento de caja es solo por la parte en efectivo', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('300.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('120.00'),
          },
          {
            metodo: PaymentMetodo.TARJETA_DEBITO,
            monto: new Prisma.Decimal('180.00'),
          },
        ],
      });

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const movimientoCall = deps.cashRegisterService.registrarMovimiento.mock
        .calls[0][1] as { monto: Prisma.Decimal.Value };
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe('120');
    });

    it('varios pagos EFECTIVO en la misma venta se suman en UN solo movimiento de caja, no uno por pago (RN-1 paso 7)', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('300.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('200.00'),
          },
        ],
      });

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const movimientoCall = deps.cashRegisterService.registrarMovimiento.mock
        .calls[0][1] as { monto: Prisma.Decimal.Value };
      expect(new Prisma.Decimal(movimientoCall.monto).toString()).toBe('300');
    });
  });

  describe('RN-7 — agregación de cantidad por variante', () => {
    it('dos líneas de la MISMA variante: la cantidad descontada es la suma, con un descontarPorVenta por línea (no fusionado)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 10 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [
          { variantId: 10, cantidad: 3 },
          { variantId: 10, cantidad: 4 },
        ],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('700.00'),
          },
        ],
      });

      // "un stock_movements por línea" (BLUEPRINT §5.3 paso 6) — dos
      // llamadas, una por cada línea, con su propia cantidad.
      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledTimes(2);
      const cantidades = deps.stockService.descontarPorVenta.mock.calls
        .map((c) => (c[1] as { cantidad: number }).cantidad)
        .sort((a, b) => a - b);
      expect(cantidades).toEqual([3, 4]);
    });

    it('vender 3+3 unidades de una variante con stock 5 se rechaza junto (RN-7: la suma de las líneas, no cada una por separado)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          items: [
            { variantId: 10, cantidad: 3 },
            { variantId: 10, cantidad: 3 },
          ],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('600.00'),
            },
          ],
        }),
      ).rejects.toThrow(/insuficiente/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });
  });

  describe('RN-3 — stock insuficiente y permitir_venta_sin_stock', () => {
    it('vender 3 unidades de una variante con stock 2 se rechaza y no genera ningún movimiento de stock ni de caja', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 2 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          items: [{ variantId: 10, cantidad: 3 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('300.00'),
            },
          ],
        }),
      ).rejects.toThrow(/insuficiente/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('permitir_venta_sin_stock = true: permite la venta igual con stock insuficiente', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 1 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps({
        settingsService: { getBool: jest.fn().mockResolvedValue(true) },
      });
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          items: [{ variantId: 10, cantidad: 5 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('500.00'),
            },
          ],
        }),
      ).resolves.toBeDefined();

      expect(deps.stockService.descontarPorVenta).toHaveBeenCalledWith(
        asTx(tx),
        expect.objectContaining({ permitirStockNegativo: true }),
      );
    });

    it('lee permitir_venta_sin_stock de SettingsService con la clave exacta', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      });

      expect(deps.settingsService.getBool).toHaveBeenCalledWith(
        'permitir_venta_sin_stock',
      );
    });
  });

  describe('invariante 3 — SUM(payments.monto) == sales.total', () => {
    it('la suma de los pagos distinta del total rechaza la venta antes de escribir nada', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('90.00'),
            },
          ],
        }),
      ).rejects.toThrow(/no cubren|total/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('la suma de los pagos que EXCEDE el total también rechaza (la igualdad tiene que ser exacta)', async () => {
      const variant = buildVariantRow({
        id: 10,
        stockActual: 5,
        precioVenta: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      ).rejects.toThrow(/no cubren|total/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
    });
  });

  describe('RN-1 paso 1 — sesión de caja abierta, siempre (hallazgo sección 5 de la spec)', () => {
    it('sin sesión de caja abierta: rechaza con el mismo mensaje que cash-registers, sin escribir nada', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps({
        cashRegisterService: {
          getSesionAbiertaOrThrow: jest
            .fn()
            .mockRejectedValue(new Error('No hay una sesión de caja abierta')),
          registrarMovimiento: jest.fn(),
        },
      });
      const service = buildService(deps);

      await expect(
        service.crearVenta(asTx(tx), {
          userId: 7,
          items: [{ variantId: 10, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
        }),
      ).rejects.toThrow(/sesi[oó]n.*abiert/i);

      expect(tx.sale.create).not.toHaveBeenCalled();
      expect(deps.stockService.descontarPorVenta).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('toma el lock de la fila de sesión SIEMPRE, incluso en una venta sin ningún pago en efectivo (hallazgo real de la sección 5 de la spec)', async () => {
      const variant = buildVariantRow({ id: 10, stockActual: 5 });
      const tx = buildMockTx([variant]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [{ variantId: 10, cantidad: 1 }],
        payments: [
          {
            metodo: PaymentMetodo.TARJETA_CREDITO,
            monto: new Prisma.Decimal('100.00'),
          },
        ],
      });

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();

      const sessionLockCall = tx.$queryRaw.mock.calls.find((call) =>
        sqlText(call).includes('cash_register_sessions'),
      );
      expect(sessionLockCall).toBeDefined();
      expect(sqlText(sessionLockCall)).toContain('for update');
      expect(sessionLockCall![1]).toBe(1);
    });
  });

  describe('BLUEPRINT §9.4 — lock de variantes ordenado por id', () => {
    it('toma un solo lock de las variantes involucradas, ordenado por id ascendente, antes de leer/validar stock', async () => {
      const rows = [
        buildVariantRow({ id: 30, stockActual: 10 }),
        buildVariantRow({ id: 10, stockActual: 10 }),
        buildVariantRow({ id: 20, stockActual: 10 }),
      ];
      const tx = buildMockTx(rows);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearVenta(asTx(tx), {
        userId: 7,
        items: [
          { variantId: 30, cantidad: 1 },
          { variantId: 10, cantidad: 1 },
          { variantId: 20, cantidad: 1 },
        ],
        payments: [
          {
            metodo: PaymentMetodo.EFECTIVO,
            monto: new Prisma.Decimal('300.00'),
          },
        ],
      });

      const variantLockCalls = tx.$queryRaw.mock.calls.filter((call) =>
        sqlText(call).includes('variants'),
      );
      expect(variantLockCalls).toHaveLength(1);

      const variantLockCall = variantLockCalls[0];
      expect(sqlText(variantLockCall)).toContain('for update');
      expect(sqlText(variantLockCall)).toContain('order by id');

      const joinArg = variantLockCall[1] as Prisma.Sql;
      expect(joinArg.values).toEqual([10, 20, 30]);

      // El lock de variantes ocurre antes de leer el stock real.
      const lockCallIndex = tx.$queryRaw.mock.calls.indexOf(variantLockCall);
      const lockOrder = tx.$queryRaw.mock.invocationCallOrder[lockCallIndex];
      const findManyOrder = tx.variant.findMany.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(findManyOrder);
    });
  });

  // Invariante 4: `total == subtotal - descuento_total + ajuste_redondeo`,
  // con `total >= 0` de forma explícita e independiente de las otras
  // cláusulas (hallazgo real de la spec, sección 3: la combinación de
  // `0 <= descuento_total <= subtotal` y `|ajuste_redondeo| < 1` NO
  // garantiza `total >= 0` por sí sola). En T4.1, sin embargo,
  // `descuento_total` y `ajuste_redondeo` están fijos en 0 (T4.3/T4.6 no
  // construidos todavía) — con ambos en 0, `total = subtotal`, y
  // `subtotal` es la suma de `cantidad * precioUnitario` con
  // `cantidad > 0` (constraint de base ya existente) y `precioUnitario`
  // siempre positivo (regla ya garantizada por `variants`, T2.3) — el
  // escenario del hallazgo (`subtotal=$0.50, descuento=$0.50,
  // ajuste=-$0.90 → total=-$0.90`) literalmente no es alcanzable con los
  // inputs que T4.1 acepta. Documentado como pendiente de T4.6 (que es
  // donde `ajusteRedondeo` deja de estar fijo en 0) en vez de forzar un
  // test que no reflejaría ningún camino real de este ticket.
  describe('invariante 4 — total >= 0', () => {
    it.todo(
      'total resultante negativo se rechaza — no alcanzable en T4.1 (descuento_total y ajuste_redondeo están fijos en 0); queda pendiente de T4.6, que es donde ajuste_redondeo deja de ser fijo',
    );
  });
});
