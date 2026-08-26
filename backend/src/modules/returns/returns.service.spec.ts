import { Prisma, PaymentMetodo } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CashRegisterService } from '../cash-registers/cash-register.service';
import type { SettingsService } from '../../common/settings/settings.service';
import type { StockService } from '../stock/stock.service';
import { ReturnsService } from './returns.service';

// Fase 04a (T5.1) — tests escritos ANTES de la implementación, en sesión
// AISLADA, contra Prisma completamente mockeado (BLUEPRINT §9.8, excepción
// "plata y stock/caja": los tests se escriben primero, derivados de la
// especificación, y se verifica que fallen antes de implementar).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` (fila T5.1, Etapa 5
// completa y su nota "Hallazgo técnico (Fase 06) + AMB-16" — leída para
// contexto general, pero esa nota es sobre T5.5/T5.8, fuera de este
// ticket); `BLUEPRINT.md` (AD-8, AD-18, AD-19, §3.5, §5.4 —ignorando la
// parte de `CAMBIO`—, invariantes 7/8/10/11/13, §9.3, §9.4, §9.7);
// `docs/build-protocol/state/reports/modulo-returns-spec.md` (RN-1 a RN-8,
// ignorando RN-9/RN-10 de `CAMBIO`/crédito diferido; secciones 3, 5 —pasos
// 1 a 13 de la devolución simple—, 6, 7, 9); `docs/build-protocol/state/
// AMBIGUITIES.md` (AMB-2 RESUELTA: 30 días configurable, reintegro
// siempre en efectivo salvo que se indique otra cosa —RN-7—, excepción
// fuera de plazo con autorización de OWNER; AMB-16 RESUELTA pero sobre
// T5.5/T5.8, no sobre T5.1).
//
// NO se abrió ningún archivo de `backend/src/modules/` salvo IMPORT DE TIPO
// de `cash-registers/cash-register.service.ts` (constructor, interfaces
// `RegistrarMovimientoInput`, firmas de `getSesionAbiertaOrThrow`/
// `registrarMovimiento` — nunca el cuerpo de sus métodos) y
// `common/settings/settings.service.ts` (firma de `getInt`, también común,
// no un módulo de negocio) para poder tipar los mocks del constructor de
// `ReturnsService`. La ESTRUCTURA MECÁNICA (MockTx/asTx, `buildDeps`,
// `buildService`, `sqlText`) sigue la misma convención ya usada en
// `sales/sales.service.spec.ts` y `cash-registers/cash-register.service.spec.ts`
// — nunca su lógica de negocio.
//
// ─── Contrato de `ReturnsService`, definido en esta sesión (la clase y el
// archivo real no existen todavía) ─────────────────────────────────────
//
// Nombre de clase: `ReturnsService`. Constructor:
//   (prisma: PrismaService, cashRegisterService: CashRegisterService,
//    settingsService: SettingsService)
// — SIN `StockService`: T5.1 (alcance explícito del ticket) no reingresa
// stock en absoluto (eso es T5.2, que depende de T5.1 y agrega el
// colaborador cuando le toque — CLAUDE.md regla 10, un ticket por vez).
//
// Método principal: `crearDevolucion(tx, input)`, mismo contrato que
// `SalesService.crearVenta` — recibe SIEMPRE el `tx` de una transacción ya
// abierta por quien llama, nunca abre la suya propia:
//   input = {
//     saleId: number;
//     items: Array<{ saleItemId: number; cantidad: number; reingresaStock: boolean }>;
//     returnPayments: Array<{ metodo: PaymentMetodo; monto: Decimal.Value; referencia?: string }>;
//     userId: number;
//     esOwner: boolean;
//     idempotencyKey: string;
//   }
// Devuelve `Promise<Return>` (la fila de `returns`, `tipo: 'DEVOLUCION'`
// siempre en este ticket — sin campo `tipo` en el input: T5.1 no
// contempla `CAMBIO`, eso es T5.5).
//
// Orden exacto (spec sección 5, pasos 1 a 11 — los pasos 12/13 de
// reingreso de stock y movimiento de caja NO corren en T5.1):
//   1. `cashRegisterService.getSesionAbiertaOrThrow(tx)` — fail-fast, RN-2.
//   2. Lock de la fila de sesión, SIEMPRE (no depende de si hay reintegro
//      en efectivo): `tx.$queryRaw` con `SELECT id FROM
//      cash_register_sessions WHERE id = ${sesion.id} FOR UPDATE`.
//   3. `tx.sale.findUnique({ where: { id: input.saleId } })` → 404 si no
//      existe; 409 si `estado === 'ANULADA'` (RN-1, AD-19).
//   4. Lock de los `sale_items` involucrados, ordenado por id (BLUEPRINT
//      §9.4): `tx.$queryRaw` con `SELECT id FROM sale_items WHERE id IN
//      (...) ORDER BY id FOR UPDATE`.
//   5. `tx.saleItem.findMany` (con el lock tomado) para leer `cantidad`/
//      `netoLinea`/`costoUnitario` de esas líneas, y
//      `tx.returnItem.findMany` para leer las devoluciones previas de esas
//      mismas líneas (acumulado de `cantidad`/`netoLinea` ya devueltos).
//   6. Validar plazo (RN-3): `fecha_actual − sale.fecha > dias_plazo_devolucion`
//      (`settingsService.getInt('dias_plazo_devolucion')`) exige
//      `esOwner === true`; si no, rechazo. Si `esOwner === true` completa
//      `autorizadoPorUserId = input.userId` (la clienta hoy no tiene
//      empleados — mismo criterio diferido que AMB-14 de `sales`).
//   7. Validar tope por línea (RN-4/invariante 8): acumulado previo +
//      cantidad nueva ≤ cantidad vendida de esa línea.
//   8. Calcular `netoLineaDevuelto` por línea (RN-5/AD-18): proporcional al
//      `neto_linea` ORIGINAL, con remanente exacto en la devolución que
//      agota la línea.
//   9. `total_devuelto = SUM(netoLineaDevuelto)`.
//  10. Validar `SUM(returnPayments.monto) == total_devuelto` (RN-7,
//      invariante 11), ANTES de escribir nada.
//  11. `tx.return.create` con `items`/`returnPayments` anidados en una
//      sola escritura nested (`data.idempotencyKey` persistido tal cual).
//
// Explícitamente FUERA de alcance de T5.1 (y de este archivo): ningún test
// de acá espera que se llame a un servicio de stock (no existe ese
// colaborador en el constructor) ni que se cree un `cash_movement` (el
// mock de `cashRegisterService.registrarMovimiento` se deja armado en
// `buildDeps` únicamente para poder afirmar explícitamente que NUNCA se
// invoca, incluso con reintegro 100% efectivo — T5.3 es quien lo conecta).
// Tampoco hay ningún test de `tipo = CAMBIO` (T5.5) ni de concurrencia real
// de dos devoluciones simultáneas de la misma línea (T5.6, Postgres real).

interface CrearDevolucionItemInput {
  saleItemId: number;
  cantidad: number;
  reingresaStock: boolean;
}

interface CrearDevolucionPaymentInput {
  metodo: PaymentMetodo;
  monto: Prisma.Decimal.Value;
  referencia?: string;
}

interface CrearDevolucionInput {
  saleId: number;
  items: CrearDevolucionItemInput[];
  returnPayments: CrearDevolucionPaymentInput[];
  userId: number;
  esOwner: boolean;
  idempotencyKey: string;
}

function buildInput(
  overrides: Partial<CrearDevolucionInput> = {},
): CrearDevolucionInput {
  return {
    saleId: 501,
    items: [{ saleItemId: 1, cantidad: 2, reingresaStock: true }],
    returnPayments: [
      { metodo: PaymentMetodo.EFECTIVO, monto: new Prisma.Decimal('200.00') },
    ],
    userId: 7,
    esOwner: false,
    idempotencyKey: 'idem-test-key',
    ...overrides,
  };
}

interface SaleItemRow {
  id: number;
  saleId: number;
  // Fase 04a (T5.2): agregado de infraestructura de test, no una regla de
  // negocio nueva — la lectura de `sale_items` que `crearDevolucion` ya
  // hace (paso 5) necesita `variantId` para poder resolverlo por línea y
  // llamar a `stockService.reingresarPorDevolucion` (T5.2). Ninguna
  // aserción de los tests de T5.1 de más abajo usa este campo, así que
  // agregarlo no cambia ningún resultado esperado de esos tests.
  variantId: number;
  cantidad: number;
  netoLinea: Prisma.Decimal;
  costoUnitario: Prisma.Decimal;
}

function buildSaleItemRow(overrides: Partial<SaleItemRow> = {}): SaleItemRow {
  return {
    id: 1,
    saleId: 501,
    variantId: 10,
    cantidad: 2,
    netoLinea: new Prisma.Decimal('200.00'),
    costoUnitario: new Prisma.Decimal('60.00'),
    ...overrides,
  };
}

interface SaleRow {
  id: number;
  estado: 'COMPLETADA' | 'ANULADA';
  fecha: Date;
  // Fase 04a (T5.3): agregado de infraestructura de test, no una regla de
  // negocio nueva — el movimiento de caja de la devolución (paso 13 de la
  // spec) arma su `descripcion` con el NÚMERO DE LA VENTA ORIGINAL
  // (`Devolución venta #${sale.numero}`), que hasta T5.2 ningún test de
  // este archivo necesitaba leer de `sale`. Mismo criterio ya usado para
  // `variantId` en `SaleItemRow`: ninguna aserción de los 22 tests de
  // T5.1/T5.2 de más arriba depende de este campo.
  numero: number;
}

function buildSaleRow(overrides: Partial<SaleRow> = {}): SaleRow {
  return {
    id: 501,
    estado: 'COMPLETADA',
    fecha: new Date(),
    numero: 4242,
    ...overrides,
  };
}

interface ReturnItemRow {
  id: number;
  saleItemId: number;
  cantidad: number;
  netoLinea: Prisma.Decimal;
}

interface SessionRow {
  id: number;
  estado: 'ABIERTA' | 'CERRADA';
}

function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return { id: 1, estado: 'ABIERTA', ...overrides };
}

interface ReturnItemCreateInput {
  saleItemId: number;
  cantidad: number;
  netoLinea: Prisma.Decimal.Value;
  costoUnitario: Prisma.Decimal.Value;
  reingresaStock: boolean;
}

interface ReturnPaymentCreateInput {
  metodo: PaymentMetodo;
  monto: Prisma.Decimal.Value;
  referencia?: string | null;
}

interface ReturnCreateCall {
  data: {
    saleId: number;
    fecha: Date;
    userId: number;
    cashRegisterSessionId: number;
    tipo: 'DEVOLUCION';
    totalDevuelto: Prisma.Decimal.Value;
    autorizadoPorUserId: number | null;
    idempotencyKey?: string;
    items: { create: ReturnItemCreateInput[] };
    returnPayments: { create: ReturnPaymentCreateInput[] };
  };
}

interface CreatedReturn {
  id: number;
  numero: number;
  items: Array<ReturnItemCreateInput & { id: number }>;
  returnPayments: Array<ReturnPaymentCreateInput & { id: number }>;
}

function buildCreatedReturnFromCall(
  call: ReturnCreateCall,
  returnId = 901,
): CreatedReturn {
  return {
    id: returnId,
    numero: returnId,
    items: call.data.items.create.map((item, index) => ({
      id: index + 1,
      ...item,
    })),
    returnPayments: call.data.returnPayments.create.map((p, index) => ({
      id: index + 1,
      ...p,
    })),
  };
}

interface MockTx {
  sale: {
    findUnique: jest.Mock<Promise<SaleRow | null>, [unknown]>;
    // Nunca se espera que `crearDevolucion` toque la venta original — se
    // deja armado para poder afirmar explícitamente `not.toHaveBeenCalled`.
    update: jest.Mock<Promise<unknown>, [unknown]>;
  };
  saleItem: {
    findMany: jest.Mock<Promise<SaleItemRow[]>, [unknown]>;
  };
  returnItem: {
    findMany: jest.Mock<Promise<ReturnItemRow[]>, [unknown]>;
  };
  return: {
    // Fase 04 (implementación): agregado para el chequeo de idempotencia
    // al principio de `crearDevolucion` (una devolución, a diferencia de
    // una venta, puede consumir EXACTO lo último disponible de una línea
    // — un reintento con la misma `idempotencyKey` que revalidara desde
    // cero vería "0 disponible" y rechazaría antes de llegar al `create`
    // cuya violación de unicidad es lo único que `withIdempotency`
    // detecta). Arreglo de infraestructura de test, no debilitamiento:
    // ningún test ni aserción existente cambia, todos siguen construyendo
    // su propio `tx` sin pasar esta opción (default `null`, mismo
    // comportamiento de siempre).
    findUnique: jest.Mock<Promise<CreatedReturn | null>, [unknown]>;
    create: jest.Mock<Promise<CreatedReturn>, [ReturnCreateCall]>;
  };
  $queryRaw: jest.Mock<
    Promise<unknown[]>,
    [TemplateStringsArray, ...unknown[]]
  >;
}

function buildMockTx(
  saleItemRows: SaleItemRow[],
  options: {
    saleRow?: SaleRow | null;
    previousReturnItems?: ReturnItemRow[];
    existingReturn?: CreatedReturn | null;
  } = {},
): MockTx {
  return {
    sale: {
      findUnique: jest
        .fn<Promise<SaleRow | null>, [unknown]>()
        .mockResolvedValue(
          options.saleRow === undefined ? buildSaleRow() : options.saleRow,
        ),
      update: jest.fn<Promise<unknown>, [unknown]>().mockResolvedValue({}),
    },
    saleItem: {
      findMany: jest
        .fn<Promise<SaleItemRow[]>, [unknown]>()
        .mockResolvedValue(saleItemRows),
    },
    returnItem: {
      findMany: jest
        .fn<Promise<ReturnItemRow[]>, [unknown]>()
        .mockResolvedValue(options.previousReturnItems ?? []),
    },
    return: {
      findUnique: jest
        .fn<Promise<CreatedReturn | null>, [unknown]>()
        .mockResolvedValue(options.existingReturn ?? null),
      create: jest
        .fn<Promise<CreatedReturn>, [ReturnCreateCall]>()
        .mockImplementation((call) =>
          Promise.resolve(buildCreatedReturnFromCall(call)),
        ),
    },
    $queryRaw: jest
      .fn<Promise<unknown[]>, [TemplateStringsArray, ...unknown[]]>()
      .mockResolvedValue([]),
  };
}

function asTx(tx: MockTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

interface Deps {
  cashRegisterService: {
    getSesionAbiertaOrThrow: jest.Mock<Promise<SessionRow>, [unknown]>;
    registrarMovimiento: jest.Mock<Promise<{ id: number }>, [unknown, unknown]>;
  };
  settingsService: {
    getInt: jest.Mock<Promise<number>, [string]>;
  };
  // Fase 04a (T5.2): agregado de infraestructura de test, mismo criterio
  // que el `variantId` de `SaleItemRow` de más arriba — el constructor de
  // `ReturnsService` gana un cuarto parámetro (`StockService`) para poder
  // delegar el reingreso real de stock (CLAUDE.md regla 4: "Solo
  // `stock.service.ts` escribe movimientos de stock"). Ninguna aserción de
  // los 17 tests de T5.1 de más abajo depende de este mock.
  stockService: {
    reingresarPorDevolucion: jest.Mock<Promise<void>, [unknown, unknown]>;
  };
}

function buildDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    cashRegisterService: {
      getSesionAbiertaOrThrow: jest
        .fn<Promise<SessionRow>, [unknown]>()
        .mockResolvedValue(buildSessionRow()),
      registrarMovimiento: jest
        .fn<Promise<{ id: number }>, [unknown, unknown]>()
        .mockResolvedValue({ id: 999 }),
    },
    settingsService: {
      // dias_plazo_devolucion, sembrado en 30 (T0.13, AMB-2 RESUELTA).
      getInt: jest.fn<Promise<number>, [string]>().mockResolvedValue(30),
    },
    stockService: {
      reingresarPorDevolucion: jest
        .fn<Promise<void>, [unknown, unknown]>()
        .mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

function buildService(deps: Deps): ReturnsService {
  return new ReturnsService(
    {} as PrismaService,
    deps.cashRegisterService as unknown as CashRegisterService,
    deps.settingsService as unknown as SettingsService,
    deps.stockService as unknown as StockService,
  );
}

function sqlText(call: unknown[]): string {
  return (call[0] as string[]).join('').toLowerCase();
}

function fechaHaceDias(dias: number): Date {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() - dias);
  return fecha;
}

describe('ReturnsService.crearDevolucion', () => {
  describe('camino feliz — reintegro 100% efectivo (RN-1 a RN-8, invariante 11)', () => {
    it('devuelve una línea completa: total_devuelto y neto_linea correctos, la venta original no se modifica, mueve la caja por el reintegro en efectivo (T5.3)', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('200.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearDevolucion(asTx(tx), buildInput());

      expect(result.id).toBeDefined();
      expect(tx.return.create).toHaveBeenCalledTimes(1);
      const call = tx.return.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.totalDevuelto).toString()).toBe(
        '200',
      );
      expect(call.data.items.create).toHaveLength(1);
      expect(
        new Prisma.Decimal(call.data.items.create[0].netoLinea).toString(),
      ).toBe('200');
      expect(call.data.items.create[0].reingresaStock).toBe(true);
      expect(call.data.items.create[0].saleItemId).toBe(1);
      expect(
        new Prisma.Decimal(call.data.returnPayments.create[0].monto).toString(),
      ).toBe('200');
      expect(call.data.saleId).toBe(501);

      // La venta original nunca se toca: `returns` solo lee `sales`.
      expect(tx.sale.update).not.toHaveBeenCalled();

      // T5.3 ya existe: el reintegro 100% efectivo de este caso mueve la
      // caja en un único movimiento por el total.
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const movimiento = deps.cashRegisterService.registrarMovimiento.mock
        .calls[0][1] as { monto: Prisma.Decimal.Value; tipo: string };
      expect(movimiento.tipo).toBe('DEVOLUCION');
      expect(new Prisma.Decimal(movimiento.monto).toString()).toBe('200');
    });
  });

  describe('camino feliz — reintegro 100% tarjeta (sin efectivo)', () => {
    it('es igual de válido: no genera ningún movimiento de caja', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('150.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );

      expect(result.id).toBeDefined();
      const call = tx.return.create.mock.calls[0][0];
      expect(new Prisma.Decimal(call.data.totalDevuelto).toString()).toBe(
        '150',
      );
      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });
  });

  describe('camino feliz — reintegro mixto (RN-7: la proporción es libre)', () => {
    it('efectivo + tarjeta en una proporción distinta a la de la venta original: se acepta, solo se valida la suma', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 3,
        netoLinea: new Prisma.Decimal('300.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 3, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('50.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_DEBITO,
              monto: new Prisma.Decimal('250.00'),
            },
          ],
        }),
      );

      expect(result.id).toBeDefined();
      const call = tx.return.create.mock.calls[0][0];
      expect(call.data.returnPayments.create).toHaveLength(2);
      expect(new Prisma.Decimal(call.data.totalDevuelto).toString()).toBe(
        '300',
      );
    });
  });

  describe('AD-18 (test obligatorio a) — neto proporcional al neto_linea original, no al precio de lista', () => {
    it('devolución parcial de una línea con descuento: neto_linea_devuelto es proporcional al NETO ORIGINAL (lo cobrado), no al precio de lista', async () => {
      // precio de lista = 34.00/u, pero la línea tiene un descuento
      // prorrateado que dejó neto_linea = 100.00 para las 3 unidades
      // vendidas (AD-18: "lo que la clienta pagó de verdad"). Se
      // devuelve 1 de esas 3 unidades.
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 3,
        netoLinea: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('33.33'),
            },
          ],
        }),
      );

      expect(result.id).toBeDefined();
      const call = tx.return.create.mock.calls[0][0];
      const netoDevuelto = new Prisma.Decimal(
        call.data.items.create[0].netoLinea,
      );
      // round(100.00 * 1/3) = 33.33 — NUNCA 34.00 (el precio de lista).
      expect(netoDevuelto.toString()).toBe('33.33');
      expect(netoDevuelto.toString()).not.toBe('34');
    });
  });

  describe('AD-18 (test obligatorio b) — la devolución que agota la línea usa el remanente exacto', () => {
    it('dos devoluciones sucesivas de la misma línea: la segunda, que agota la cantidad vendida, usa el remanente exacto — la suma nunca difiere del neto_linea original', async () => {
      // neto_linea original = 50.01, cantidad_vendida = 2. La fórmula
      // proporcional para 1 de 2 unidades: round(50.01 * 1/2) =
      // round(25.005) = 25.01 (redondeo comercial, medio hacia arriba).
      // Si la SEGUNDA devolución (que agota la línea) aplicara la misma
      // fórmula de nuevo, daría otra vez 25.01 — la suma sería 50.02, un
      // centavo MÁS que el neto_linea original. AD-18 exige que la
      // devolución que agota la línea use el remanente exacto en cambio
      // (50.01 − 25.01 = 25.00), para que la suma nunca se pase.
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('50.01'),
      });

      // Primera devolución: sin devoluciones previas de esta línea.
      const tx1 = buildMockTx([saleItem]);
      const deps1 = buildDeps();
      const service1 = buildService(deps1);
      await service1.crearDevolucion(
        asTx(tx1),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('25.01'),
            },
          ],
        }),
      );
      const call1 = tx1.return.create.mock.calls[0][0];
      const netoPrimera = new Prisma.Decimal(
        call1.data.items.create[0].netoLinea,
      );
      expect(netoPrimera.toString()).toBe('25.01');

      // Segunda devolución: agota la línea (1 + 1 = 2 = cantidad vendida).
      // La devolución previa ya devolvió 25.01 de los 50.01 originales.
      const tx2 = buildMockTx([saleItem], {
        previousReturnItems: [
          { id: 1, saleItemId: 1, cantidad: 1, netoLinea: netoPrimera },
        ],
      });
      const deps2 = buildDeps();
      const service2 = buildService(deps2);
      await service2.crearDevolucion(
        asTx(tx2),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('25.00'),
            },
          ],
        }),
      );
      const call2 = tx2.return.create.mock.calls[0][0];
      const netoSegunda = new Prisma.Decimal(
        call2.data.items.create[0].netoLinea,
      );

      // Remanente exacto: 50.01 − 25.01 = 25.00 — NUNCA 25.01 (lo que
      // daría la fórmula proporcional aplicada de nuevo a esta línea).
      expect(netoSegunda.toString()).toBe('25');
      expect(netoPrimera.plus(netoSegunda).toString()).toBe('50.01');
    });
  });

  describe('rechazo — venta inexistente', () => {
    it('rechaza (venta no encontrada), sin crear ninguna devolución', async () => {
      const tx = buildMockTx([], { saleRow: null });
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(asTx(tx), buildInput()),
      ).rejects.toThrow(/venta no encontrada/i);

      expect(tx.return.create).not.toHaveBeenCalled();
    });
  });

  describe('rechazo — venta ANULADA (AD-19)', () => {
    it('rechaza (una venta anulada no admite devoluciones), sin crear nada', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ estado: 'ANULADA' }),
      });
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(asTx(tx), buildInput()),
      ).rejects.toThrow(/anulada/i);

      expect(tx.return.create).not.toHaveBeenCalled();
    });
  });

  describe('rechazo — cantidad supera lo vendido en una línea (invariante 8, request único)', () => {
    it('rechaza sin crear nada', async () => {
      const saleItem = buildSaleItemRow({ id: 1, cantidad: 2 });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(
          asTx(tx),
          buildInput({
            items: [{ saleItemId: 1, cantidad: 3, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('300.00'),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/supera|disponible/i);

      expect(tx.return.create).not.toHaveBeenCalled();
    });
  });

  describe('rechazo — cantidad supera lo vendido considerando una devolución previa (acumulado)', () => {
    it('rechaza sin crear nada', async () => {
      const saleItem = buildSaleItemRow({ id: 1, cantidad: 3 });
      const tx = buildMockTx([saleItem], {
        previousReturnItems: [
          {
            id: 1,
            saleItemId: 1,
            cantidad: 2,
            netoLinea: new Prisma.Decimal('100.00'),
          },
        ],
      });
      const deps = buildDeps();
      const service = buildService(deps);

      // Ya se devolvieron 2 de 3; pedir 2 más (2+2=4 > 3) tiene que
      // rechazar, aunque un request aislado de "2" sería válido si no
      // hubiera devoluciones previas.
      await expect(
        service.crearDevolucion(
          asTx(tx),
          buildInput({
            items: [{ saleItemId: 1, cantidad: 2, reingresaStock: true }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/supera|disponible/i);

      expect(tx.return.create).not.toHaveBeenCalled();
    });
  });

  describe('rechazo — fuera de plazo sin autorización (RN-3, AMB-2)', () => {
    it('esOwner: false y la venta tiene más de dias_plazo_devolucion: rechaza sin crear nada', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ fecha: fechaHaceDias(45) }),
      });
      const deps = buildDeps(); // getInt('dias_plazo_devolucion') → 30
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(asTx(tx), buildInput({ esOwner: false })),
      ).rejects.toThrow(/plazo/i);

      expect(tx.return.create).not.toHaveBeenCalled();
    });
  });

  describe('aceptado — fuera de plazo CON autorización (RN-3, AMB-2)', () => {
    it('esOwner: true: se acepta y completa autorizado_por_user_id con quien opera', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ fecha: fechaHaceDias(45) }),
      });
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({ esOwner: true, userId: 3 }),
      );

      const call = tx.return.create.mock.calls[0][0];
      expect(call.data.autorizadoPorUserId).toBe(3);
    });

    it('dentro de plazo: autorizado_por_user_id queda null, sin importar esOwner', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ fecha: fechaHaceDias(5) }),
      });
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(asTx(tx), buildInput({ esOwner: false }));

      const call = tx.return.create.mock.calls[0][0];
      expect(call.data.autorizadoPorUserId).toBeNull();
    });
  });

  describe('rechazo — sin sesión de caja abierta (RN-2, invariante 10)', () => {
    it('rechaza con el mismo mecanismo que cash-registers/sales, sin llegar a leer la venta ni crear nada', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps({
        cashRegisterService: {
          getSesionAbiertaOrThrow: jest
            .fn<Promise<SessionRow>, [unknown]>()
            .mockRejectedValue(new Error('No hay una sesión de caja abierta')),
          registrarMovimiento: jest.fn<
            Promise<{ id: number }>,
            [unknown, unknown]
          >(),
        },
      });
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(asTx(tx), buildInput()),
      ).rejects.toThrow(/sesión de caja abierta/i);

      // RN-2: el lock/verificación de sesión ocurre ANTES de leer la venta.
      expect(tx.sale.findUnique).not.toHaveBeenCalled();
      expect(tx.return.create).not.toHaveBeenCalled();
    });
  });

  describe('rechazo — SUM(return_payments.monto) != total_devuelto (invariante 11)', () => {
    it('rechaza sin crear nada', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('200.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(
          asTx(tx),
          buildInput({
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('150.00'),
              },
            ],
          }),
        ),
      ).rejects.toThrow(/no cubren|reintegr/i);

      expect(tx.return.create).not.toHaveBeenCalled();
    });
  });

  describe('idempotencia (RN-9/§9.7) — la clave se persiste tal cual', () => {
    it('idempotencyKey queda en la devolución creada', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({ idempotencyKey: 'clave-unica-123' }),
      );

      const call = tx.return.create.mock.calls[0][0];
      expect(call.data.idempotencyKey).toBe('clave-unica-123');
    });
  });

  describe('BLUEPRINT §9.4 — lock de la sesión de caja, siempre', () => {
    it('toma el lock de la fila de sesión incluso cuando el reintegro es 100% tarjeta (sin efectivo)', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('150.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );

      const sessionLockCall = tx.$queryRaw.mock.calls.find((call) =>
        sqlText(call).includes('cash_register_sessions'),
      );
      expect(sessionLockCall).toBeDefined();
      expect(sqlText(sessionLockCall!)).toContain('for update');
    });
  });

  describe('BLUEPRINT §9.4 — lock de los sale_items involucrados, ordenado por id', () => {
    it('toma un lock de las líneas de venta involucradas, ordenado por id ascendente, antes de leer los acumulados de devoluciones previas', async () => {
      const item1 = buildSaleItemRow({ id: 5, cantidad: 2 });
      const item2 = buildSaleItemRow({ id: 2, cantidad: 2 });
      const tx = buildMockTx([item1, item2]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [
            { saleItemId: 5, cantidad: 1, reingresaStock: true },
            { saleItemId: 2, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('200.00'),
            },
          ],
        }),
      );

      const lockCall = tx.$queryRaw.mock.calls.find((call) =>
        sqlText(call).includes('sale_items'),
      );
      expect(lockCall).toBeDefined();
      expect(sqlText(lockCall!)).toContain('for update');
      expect(sqlText(lockCall!)).toContain('order by id');

      // El lock de sale_items ocurre antes de leer los acumulados previos.
      const lockCallIndex = tx.$queryRaw.mock.calls.indexOf(lockCall!);
      const readAcumuladoCallOrder =
        tx.returnItem.findMany.mock.invocationCallOrder[0];
      const lockCallOrder =
        tx.$queryRaw.mock.invocationCallOrder[lockCallIndex];
      expect(lockCallOrder).toBeLessThan(readAcumuladoCallOrder);
    });
  });

  // Fase 04a (T5.2) — tests NUEVOS, agregados a este archivo sin tocar
  // ninguna aserción de los 17 tests de T5.1 de más arriba. Fuente:
  // `state/reports/modulo-returns-spec.md` (sección 5, paso 12) — por cada
  // `return_item` con `reingresaStock = true`, DESPUÉS de `tx.return.create`
  // (recién ahí existe `return.id`), una llamada a
  // `stockService.reingresarPorDevolucion(tx, { variantId, cantidad,
  // returnId, userId })` por línea, nunca agrupada.
  describe('T5.2 — reingreso de stock, delegado a StockService (spec sección 5, paso 12)', () => {
    it('reingresaStock: true → llama a stockService.reingresarPorDevolucion UNA vez, con el variantId, la cantidad y el returnId correctos', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        variantId: 42,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('200.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 2, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('200.00'),
            },
          ],
        }),
      );

      expect(deps.stockService.reingresarPorDevolucion).toHaveBeenCalledTimes(
        1,
      );
      expect(deps.stockService.reingresarPorDevolucion).toHaveBeenCalledWith(
        expect.anything(),
        { variantId: 42, cantidad: 2, returnId: result.id, userId: 7 },
      );
    });

    it('reingresaStock: false → nunca llama a stockService.reingresarPorDevolucion para esa línea', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        variantId: 42,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: false }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
        }),
      );

      expect(deps.stockService.reingresarPorDevolucion).not.toHaveBeenCalled();
    });

    it('dos líneas, una reingresaStock: true y otra false → se llama exactamente una vez, solo para la línea true (nunca agrupado en una sola llamada)', async () => {
      const item1 = buildSaleItemRow({
        id: 5,
        variantId: 11,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('100.00'),
      });
      const item2 = buildSaleItemRow({
        id: 6,
        variantId: 22,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('50.00'),
      });
      const tx = buildMockTx([item1, item2]);
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [
            { saleItemId: 5, cantidad: 2, reingresaStock: true },
            { saleItemId: 6, cantidad: 1, reingresaStock: false },
          ],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );

      expect(deps.stockService.reingresarPorDevolucion).toHaveBeenCalledTimes(
        1,
      );
      expect(deps.stockService.reingresarPorDevolucion).toHaveBeenCalledWith(
        expect.anything(),
        { variantId: 11, cantidad: 2, returnId: result.id, userId: 7 },
      );
    });

    it('la llamada a stockService.reingresarPorDevolucion ocurre DESPUÉS de tx.return.create (recién ahí existe return.id)', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        variantId: 42,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
        }),
      );

      const createOrder = tx.return.create.mock.invocationCallOrder[0];
      const reingresoOrder =
        deps.stockService.reingresarPorDevolucion.mock.invocationCallOrder[0];
      expect(reingresoOrder).toBeGreaterThan(createOrder);
    });

    it('si la devolución se rechaza (venta ANULADA, AD-19), nunca llama a stockService.reingresarPorDevolucion', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ estado: 'ANULADA' }),
      });
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(asTx(tx), buildInput()),
      ).rejects.toThrow(/anulada/i);

      expect(deps.stockService.reingresarPorDevolucion).not.toHaveBeenCalled();
    });
  });

  // Fase 04a (T5.3) — tests NUEVOS, agregados a este archivo sin tocar
  // ninguna aserción de los 22 tests de T5.1/T5.2 de más arriba. Fuente:
  // `state/reports/modulo-returns-spec.md` (sección 5, paso 13) y
  // BLUEPRINT AD-8/invariante 7/§3.6: si
  // `SUM(returnPayments.monto WHERE metodo = EFECTIVO) > 0`, UNA sola
  // llamada (nunca por línea) a `cashRegisterService.registrarMovimiento`
  // con `tipo: 'DEVOLUCION'`, `monto` esa suma (SIEMPRE POSITIVA — el
  // signo con que queda en la base lo resuelve `registrarMovimiento`
  // internamente, mismo criterio que `sales` con `VENTA`/`ANULACION`, no
  // algo que `ReturnsService` decida), `referenciaTipo: 'RETURN'`,
  // `referenciaId` el id de la devolución recién creada, `sessionId` el de
  // la sesión abierta, `descripcion` con el número de la VENTA ORIGINAL.
  // Si no hay nada en efectivo, `registrarMovimiento` nunca se llama —
  // igual que `sales` con un pago 100% no efectivo.
  interface RegistrarMovimientoCallInput {
    sessionId: number;
    tipo: string;
    monto: Prisma.Decimal.Value;
    referenciaTipo?: string;
    referenciaId?: number;
    descripcion: string;
    userId: number;
  }

  function ultimoLlamadoRegistrarMovimiento(
    deps: Deps,
  ): RegistrarMovimientoCallInput {
    const calls = deps.cashRegisterService.registrarMovimiento.mock.calls;
    return calls[calls.length - 1][1] as RegistrarMovimientoCallInput;
  }

  describe('T5.3 — movimiento de caja por reintegro en efectivo (invariante 7, AD-8)', () => {
    it('reintegro 100% efectivo: registrarMovimiento se llama UNA vez, con tipo DEVOLUCION, el monto total (positivo), referenciaTipo RETURN, el id de la devolución y la sesión abierta', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('200.00'),
      });
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ numero: 4242 }),
      });
      const deps = buildDeps();
      const service = buildService(deps);

      const result = await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 2, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('200.00'),
            },
          ],
        }),
      );

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const call = ultimoLlamadoRegistrarMovimiento(deps);
      expect(call.tipo).toBe('DEVOLUCION');
      expect(new Prisma.Decimal(call.monto).toString()).toBe('200');
      expect(call.referenciaTipo).toBe('RETURN');
      expect(call.referenciaId).toBe(result.id);
      expect(call.sessionId).toBe(buildSessionRow().id);
    });

    it('reintegro 100% tarjeta: registrarMovimiento nunca se llama', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('150.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.TARJETA_CREDITO,
              monto: new Prisma.Decimal('150.00'),
            },
          ],
        }),
      );

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('reintegro mixto (efectivo + tarjeta): registrarMovimiento se llama UNA sola vez, con el monto SOLO de la parte en efectivo, nunca el total devuelto', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 3,
        netoLinea: new Prisma.Decimal('300.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 3, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('50.00'),
            },
            {
              metodo: PaymentMetodo.TARJETA_DEBITO,
              monto: new Prisma.Decimal('250.00'),
            },
          ],
        }),
      );

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const call = ultimoLlamadoRegistrarMovimiento(deps);
      // Solo la parte efectivo (50.00), nunca el total_devuelto (300.00).
      expect(new Prisma.Decimal(call.monto).toString()).toBe('50');
      expect(new Prisma.Decimal(call.monto).toString()).not.toBe('300');
    });

    it('dos pagos en efectivo declarados por separado: registrarMovimiento se llama UNA sola vez, con la SUMA de ambos', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('200.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 2, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('120.00'),
            },
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('80.00'),
            },
          ],
        }),
      );

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const call = ultimoLlamadoRegistrarMovimiento(deps);
      expect(new Prisma.Decimal(call.monto).toString()).toBe('200');
    });

    it('la descripción incluye el número de la VENTA ORIGINAL (sale.numero), no el de la devolución', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ numero: 7777 }),
      });
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
        }),
      );

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const call = ultimoLlamadoRegistrarMovimiento(deps);
      expect(call.descripcion).toContain('7777');
    });

    it('si la devolución se rechaza (venta ANULADA, AD-19), registrarMovimiento nunca se llama, aun con reintegro 100% efectivo', async () => {
      const saleItem = buildSaleItemRow();
      const tx = buildMockTx([saleItem], {
        saleRow: buildSaleRow({ estado: 'ANULADA' }),
      });
      const deps = buildDeps();
      const service = buildService(deps);

      await expect(
        service.crearDevolucion(asTx(tx), buildInput()),
      ).rejects.toThrow(/anulada/i);

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).not.toHaveBeenCalled();
    });

    it('la llamada a registrarMovimiento ocurre DESPUÉS de tx.return.create (recién ahí existe return.id)', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('100.00'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('100.00'),
            },
          ],
        }),
      );

      expect(
        deps.cashRegisterService.registrarMovimiento,
      ).toHaveBeenCalledTimes(1);
      const createOrder = tx.return.create.mock.invocationCallOrder[0];
      const movimientoOrder =
        deps.cashRegisterService.registrarMovimiento.mock
          .invocationCallOrder[0];
      expect(movimientoOrder).toBeGreaterThan(createOrder);
    });
  });

  // Fase 04a (T5.4) — tests escritos ANTES de cualquier cambio de
  // implementación, en sesión AISLADA. Fuente única:
  // `docs/build-protocol/state/reports/modulo-returns-spec.md` RN-6,
  // sección 2 (aclaración explícita: `returns` no ejecuta ninguna resta de
  // costo activa — `return_items.costo_unitario` se copia tal cual de
  // `sale_items.costo_unitario`, mismo congelado que ya hizo `sales`,
  // BLUEPRINT AD-5); BLUEPRINT §5.6 (el filtro `reingresa_stock = true` lo
  // aplica `resultados`, Etapa 6, todavía sin construir — no este módulo).
  // A diferencia de T5.1/T5.2/T5.3, ningún test de arriba afirma
  // explícitamente sobre el VALOR de `costo_unitario` en el `create` — este
  // bloque lo hace de forma directa, sin importar el resultado (puede que
  // ya pase en verde contra la implementación actual de T5.1).
  describe('T5.4 — costo_unitario congelado, para el CMV de resultados (BLUEPRINT §5.6, RN-6)', () => {
    it('copia costo_unitario TAL CUAL de la línea de venta original (AD-5) — no un valor recalculado ni el que traiga otra fuente', async () => {
      const saleItem = buildSaleItemRow({
        id: 1,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('200.00'),
        costoUnitario: new Prisma.Decimal('73.50'),
      });
      const tx = buildMockTx([saleItem]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(asTx(tx), buildInput());

      const call = tx.return.create.mock.calls[0][0];
      expect(
        new Prisma.Decimal(call.data.items.create[0].costoUnitario).toString(),
      ).toBe('73.5');
    });

    it('con reingresaStock: true, el costo_unitario copiado es el mismo que con reingresaStock: false — el dato se persiste igual en los dos casos', async () => {
      for (const reingresaStock of [true, false]) {
        const saleItem = buildSaleItemRow({
          id: 1,
          cantidad: 1,
          netoLinea: new Prisma.Decimal('100.00'),
          costoUnitario: new Prisma.Decimal('40.00'),
        });
        const tx = buildMockTx([saleItem]);
        const deps = buildDeps();
        const service = buildService(deps);

        await service.crearDevolucion(
          asTx(tx),
          buildInput({
            items: [{ saleItemId: 1, cantidad: 1, reingresaStock }],
            returnPayments: [
              {
                metodo: PaymentMetodo.EFECTIVO,
                monto: new Prisma.Decimal('100.00'),
              },
            ],
          }),
        );

        const call = tx.return.create.mock.calls[0][0];
        expect(
          new Prisma.Decimal(
            call.data.items.create[0].costoUnitario,
          ).toString(),
        ).toBe('40');
        expect(call.data.items.create[0].reingresaStock).toBe(reingresaStock);
      }
    });

    it('con DOS líneas de costos distintos en la misma devolución, cada return_item lleva el costo_unitario de SU línea, no un valor mezclado ni el de la otra', async () => {
      const saleItemA = buildSaleItemRow({
        id: 1,
        cantidad: 2,
        netoLinea: new Prisma.Decimal('100.00'),
        costoUnitario: new Prisma.Decimal('30.00'),
      });
      const saleItemB = buildSaleItemRow({
        id: 2,
        cantidad: 1,
        netoLinea: new Prisma.Decimal('70.00'),
        costoUnitario: new Prisma.Decimal('55.25'),
      });
      const tx = buildMockTx([saleItemA, saleItemB]);
      const deps = buildDeps();
      const service = buildService(deps);

      await service.crearDevolucion(
        asTx(tx),
        buildInput({
          items: [
            { saleItemId: 1, cantidad: 2, reingresaStock: true },
            { saleItemId: 2, cantidad: 1, reingresaStock: false },
          ],
          returnPayments: [
            {
              metodo: PaymentMetodo.EFECTIVO,
              monto: new Prisma.Decimal('170.00'),
            },
          ],
        }),
      );

      const call = tx.return.create.mock.calls[0][0];
      const itemA = call.data.items.create.find((i) => i.saleItemId === 1)!;
      const itemB = call.data.items.create.find((i) => i.saleItemId === 2)!;
      expect(new Prisma.Decimal(itemA.costoUnitario).toString()).toBe('30');
      expect(new Prisma.Decimal(itemB.costoUnitario).toString()).toBe(
        '55.25',
      );
    });
  });
});
