import { BadRequestException } from '@nestjs/common';
import { Prisma, SaleEstado } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  ResultadosService,
  ResultadosQuery,
  RankingProductosQuery,
  GastosPorCategoriaQuery,
} from './resultados.service';
import { argentinaDayRangeToUtc } from '../../common/timezone/argentina-timezone.util';

// Fase 04a (T6.4) — tests escritos ANTES de la implementación, contra
// Prisma completamente mockeado (nunca `tx` recibido de un controller:
// `consultar` abre su PROPIA transacción de lectura, mismo contrato que
// `SalesService.reconciliar()`/`ReturnsService.consultarCredito()`).
// Fuente única: el ticket T6.4 pasado en el prompt de esta fase (derivado
// de `ROADMAP.md`, BLUEPRINT §5.6 y su fórmula textual, invariante 9 —
// "al día de hoy, no fotos inmutables" — y la tabla de errores de la spec
// del módulo, sección 7). NO se leyó ningún archivo `resultados*` (no
// existía) ni se copió la lógica de `expenses.service.ts` — solo se
// reusó, como convención MECÁNICA del repo, el patrón de mock de
// `$transaction`/`isolationLevel: RepeatableRead` de
// `sales.service.spec.ts` (describe `SalesService.reconciliar`, T4.8) y
// el patrón de `tx.returnPayment.aggregate({ where, _sum })` de
// `returns.service.ts` (`consultarCredito`, T5.8) para sumar una sola
// columna Decimal.
//
// ─── Diseño de queries que este archivo fija como contrato ──────────────
// (a implementar en la Fase 04, otra sesión — acá solo se pinnea la FORMA
// exacta que la Fase04a puede verificar con `toHaveBeenCalledWith`, nunca
// el cálculo interno):
//   - `tx.sale.aggregate({ where: { estado: COMPLETADA, fecha: {gte,lte} },
//     _sum: { total: true } })` — base de ingresos (filtro 1).
//   - `tx.return.aggregate({ where: { fecha: {gte,lte} },
//     _sum: { totalDevuelto: true } })` — resta de ingresos (`Return` no
//     tiene `estado` propio, BLUEPRINT: "las devoluciones no se anulan").
//   - `tx.saleItem.findMany({ where: { sale: { estado: COMPLETADA,
//     fecha: {gte,lte} } }, select: { cantidad, costoUnitario } })` — CMV
//     base, JOIN a la cabecera de venta (filtro 1 + filtro 3 estructural).
//     `cantidad × costoUnitario` no es una columna: se suma en JS con
//     `Prisma.Decimal`, mismo criterio que `lineSubtotal`/`prorate` de
//     `money.util.ts` — nunca con `number`.
//   - `tx.returnItem.findMany({ where: { reingresaStock: true,
//     return: { fecha: {gte,lte} } }, select: { cantidad, costoUnitario } })`
//     — reversión del CMV, JOIN a la cabecera de devolución (filtro 2 +
//     filtro 3 estructural).
//   - `tx.expense.aggregate({ where: { fecha: {gte,lte} },
//     _sum: { monto: true } })` — gastos del período.
// Los límites `gte`/`lte` salían, hasta T6.4, de `desde 00:00:00.000Z` /
// `hasta 23:59:59.999Z` (UTC ingenuo) — esa fue la interpretación
// deliberadamente provisional de T6.4 (AD-13 quedaba fuera de alcance,
// a la espera de T0.7). **T6.5 (esta fase) conecta la conversión real**:
// los límites ahora salen de `argentinaDayRangeToUtc` (T0.7, ya VERDE) —
// medianoche a medianoche EN HORA ARGENTINA, convertida a UTC. Los tres
// tests que fijaban el cálculo ingenuo como contrato (filtros 1/2/3, más
// abajo) se actualizaron para reflejar esto — mismo criterio ya usado
// para actualizar tests heredados de un ticket anterior (T6.2 → T6.3).
//
// Todos los importes de la respuesta son `string` de 2 decimales
// (BLUEPRINT §9.3) — `margenBrutoPct` también, aunque sea un porcentaje,
// con el mismo redondeo (`Prisma.Decimal.ROUND_HALF_UP`) que
// `roundCurrency` de `money.util.ts`, tal como pide el prompt de esta
// fase.

interface AggregateResult<K extends string> {
  _sum: Record<K, Prisma.Decimal | null>;
}

interface ItemRow {
  cantidad: number;
  costoUnitario: Prisma.Decimal;
}

interface MockTx {
  sale: {
    aggregate: jest.Mock<Promise<AggregateResult<'total'>>, [unknown]>;
  };
  return: {
    aggregate: jest.Mock<Promise<AggregateResult<'totalDevuelto'>>, [unknown]>;
  };
  saleItem: {
    findMany: jest.Mock<Promise<ItemRow[]>, [unknown]>;
  };
  returnItem: {
    findMany: jest.Mock<Promise<ItemRow[]>, [unknown]>;
  };
  expense: {
    aggregate: jest.Mock<Promise<AggregateResult<'monto'>>, [unknown]>;
  };
}

interface BuildTxOptions {
  ventasTotal?: string | null;
  devolucionesTotal?: string | null;
  saleItems?: Array<{ cantidad: number; costoUnitario: string }>;
  returnItems?: Array<{ cantidad: number; costoUnitario: string }>;
  gastosTotal?: string | null;
}

// Por default, un período completamente vacío — sin ninguna venta,
// devolución, línea o gasto. Los tests del "camino feliz" pisan
// explícitamente lo que necesitan (mismo criterio que `buildMockTx` de
// `expenses.service.spec.ts`).
function buildMockTx(options: BuildTxOptions = {}): MockTx {
  const sumOrNull = (v: string | null | undefined): Prisma.Decimal | null =>
    v == null ? null : new Prisma.Decimal(v);

  return {
    sale: {
      aggregate: jest
        .fn<Promise<AggregateResult<'total'>>, [unknown]>()
        .mockResolvedValue({
          _sum: { total: sumOrNull(options.ventasTotal) },
        }),
    },
    return: {
      aggregate: jest
        .fn<Promise<AggregateResult<'totalDevuelto'>>, [unknown]>()
        .mockResolvedValue({
          _sum: { totalDevuelto: sumOrNull(options.devolucionesTotal) },
        }),
    },
    saleItem: {
      findMany: jest.fn<Promise<ItemRow[]>, [unknown]>().mockResolvedValue(
        (options.saleItems ?? []).map((i) => ({
          cantidad: i.cantidad,
          costoUnitario: new Prisma.Decimal(i.costoUnitario),
        })),
      ),
    },
    returnItem: {
      findMany: jest.fn<Promise<ItemRow[]>, [unknown]>().mockResolvedValue(
        (options.returnItems ?? []).map((i) => ({
          cantidad: i.cantidad,
          costoUnitario: new Prisma.Decimal(i.costoUnitario),
        })),
      ),
    },
    expense: {
      aggregate: jest
        .fn<Promise<AggregateResult<'monto'>>, [unknown]>()
        .mockResolvedValue({
          _sum: { monto: sumOrNull(options.gastosTotal) },
        }),
    },
  };
}

type TransactionMock = jest.Mock<
  Promise<unknown>,
  [
    (t: Prisma.TransactionClient) => unknown,
    { isolationLevel?: Prisma.TransactionIsolationLevel }?,
  ]
>;

function buildService(tx: MockTx): {
  service: ResultadosService;
  transactionMock: TransactionMock;
} {
  const transactionMock: TransactionMock = jest
    .fn<
      Promise<unknown>,
      [
        (t: Prisma.TransactionClient) => unknown,
        { isolationLevel?: Prisma.TransactionIsolationLevel }?,
      ]
    >()
    .mockImplementation((callback) =>
      Promise.resolve(callback(tx as unknown as Prisma.TransactionClient)),
    );
  const prisma = { $transaction: transactionMock } as unknown as PrismaService;
  return { service: new ResultadosService(prisma), transactionMock };
}

function query(desde: string, hasta: string): ResultadosQuery {
  return { desde, hasta };
}

describe('ResultadosService.consultar (T6.4)', () => {
  it('camino feliz: ingresos, cmv, margenBruto, margenBrutoPct, gastos y resultadoNeto — calculados a mano ANTES del expect', async () => {
    // Cálculo a mano, no copiado de ninguna fórmula del código:
    //   ventas completadas del período: $350.00
    //   devoluciones del período:        $50.00
    //   ingresos = 350.00 − 50.00 = 300.00
    //
    //   sale_items de esas ventas: 2×$60.00 + 2×$50.00 = 120.00 + 100.00 = 220.00
    //   return_items reingresaStock=true: 1×$20.00 = 20.00
    //   cmv = 220.00 − 20.00 = 200.00
    //
    //   margenBruto = 300.00 − 200.00 = 100.00
    //   margenBrutoPct = 100.00 / 300.00 × 100 = 33.333...% → ROUND_HALF_UP
    //     a 2 decimales = 33.33
    //
    //   gastos = 40.00
    //   resultadoNeto = 100.00 − 40.00 = 60.00
    const tx = buildMockTx({
      ventasTotal: '350.00',
      devolucionesTotal: '50.00',
      saleItems: [
        { cantidad: 2, costoUnitario: '60.00' },
        { cantidad: 2, costoUnitario: '50.00' },
      ],
      returnItems: [{ cantidad: 1, costoUnitario: '20.00' }],
      gastosTotal: '40.00',
    });
    const { service } = buildService(tx);

    const result = await service.consultar(query('2026-01-01', '2026-01-31'));

    expect(result.ingresos).toBe('300.00');
    expect(result.cmv).toBe('200.00');
    expect(result.margenBruto).toBe('100.00');
    expect(result.margenBrutoPct).toBe('33.33');
    expect(result.gastos).toBe('40.00');
    expect(result.resultadoNeto).toBe('60.00');
    expect(result.periodo).toEqual({
      desde: '2026-01-01',
      hasta: '2026-01-31',
    });
  });

  it('filtro 1: la query de ventas (ingresos) Y la de sale_items (CMV) filtran por estado: COMPLETADA — where exacto', async () => {
    const tx = buildMockTx();
    const { service } = buildService(tx);
    // T6.5 (AD-13): este test fijaba a propósito los límites UTC ingenuos
    // como contrato ("sin ajuste de hora argentina — eso es T6.5", T6.4).
    // Con T6.5 conectando `argentinaDayRangeToUtc` (T0.7, ya VERDE, sin
    // mockear — es la fuente real), el servicio ahora manda límites
    // distintos: medianoche a medianoche EN HORA ARGENTINA, ya convertida
    // a UTC. No es un debilitamiento — es la expectativa provisional que
    // el propio T6.4 avisó que iba a cambiar, corregida a la real (mismo
    // criterio ya usado para actualizar el `it.each` de T6.2 → T6.3).
    const desde = argentinaDayRangeToUtc('2026-02-01').desde;
    const hasta = argentinaDayRangeToUtc('2026-02-28').hasta;

    await service.consultar(query('2026-02-01', '2026-02-28'));

    expect(tx.sale.aggregate).toHaveBeenCalledWith({
      where: {
        estado: SaleEstado.COMPLETADA,
        fecha: { gte: desde, lte: hasta },
      },
      _sum: { total: true },
    });
    expect(tx.saleItem.findMany).toHaveBeenCalledWith({
      where: {
        sale: {
          estado: SaleEstado.COMPLETADA,
          fecha: { gte: desde, lte: hasta },
        },
      },
      select: { cantidad: true, costoUnitario: true },
    });
  });

  it('filtro 2: la query de return_items (reversión del CMV) filtra por reingresaStock: true — where exacto', async () => {
    const tx = buildMockTx();
    const { service } = buildService(tx);
    // T6.5 (AD-13): mismo cambio que en el test de filtro 1 — los límites
    // ya no son UTC ingenuo, salen de `argentinaDayRangeToUtc` (T0.7).
    const desde = argentinaDayRangeToUtc('2026-03-01').desde;
    const hasta = argentinaDayRangeToUtc('2026-03-31').hasta;

    await service.consultar(query('2026-03-01', '2026-03-31'));

    expect(tx.returnItem.findMany).toHaveBeenCalledWith({
      where: {
        reingresaStock: true,
        return: { fecha: { gte: desde, lte: hasta } },
      },
      select: { cantidad: true, costoUnitario: true },
    });
  });

  it('filtro 3, completo: fecha de cabecera + hora argentina (AD-13, T6.5): los límites gte/lte que llegan a la query de gastos y de devoluciones salen de argentinaDayRangeToUtc, no de UTC ingenuo', async () => {
    const tx = buildMockTx();
    const { service } = buildService(tx);
    // T6.5: este test se llamaba "mitad estructural (sin ajuste de hora
    // argentina — eso es T6.5)" en T6.4 — ahora que T6.5 conecta la
    // conversión real, queda "completo": la fecha de cabecera SIGUE
    // siendo la que se filtra (eso no cambia), pero además con el ajuste
    // de hora argentina ya aplicado.
    const { desde, hasta } = argentinaDayRangeToUtc('2026-05-10');

    await service.consultar(query('2026-05-10', '2026-05-10'));

    expect(tx.return.aggregate).toHaveBeenCalledWith({
      where: { fecha: { gte: desde, lte: hasta } },
      _sum: { totalDevuelto: true },
    });
    expect(tx.expense.aggregate).toHaveBeenCalledWith({
      where: { fecha: { gte: desde, lte: hasta } },
      _sum: { monto: true },
    });
  });

  it('filtro 3, rango de más de un día (AD-13, T6.5): gte sale del INICIO del primer día en hora argentina, lte sale del FIN del último día — nunca los límites de un solo día aplicados a todo el rango', async () => {
    const tx = buildMockTx();
    const { service } = buildService(tx);
    // Distinto de los tests de arriba: acá `desde` y `hasta` son DÍAS
    // DISTINTOS ('2026-04-01' a '2026-04-05') — el `gte` esperado tiene
    // que salir del rango del PRIMER día y el `lte` del rango del
    // ÚLTIMO, no ambos del mismo cálculo de un solo día.
    const desde = argentinaDayRangeToUtc('2026-04-01').desde;
    const hasta = argentinaDayRangeToUtc('2026-04-05').hasta;

    await service.consultar(query('2026-04-01', '2026-04-05'));

    expect(tx.sale.aggregate).toHaveBeenCalledWith({
      where: {
        estado: SaleEstado.COMPLETADA,
        fecha: { gte: desde, lte: hasta },
      },
      _sum: { total: true },
    });
    expect(tx.return.aggregate).toHaveBeenCalledWith({
      where: { fecha: { gte: desde, lte: hasta } },
      _sum: { totalDevuelto: true },
    });
    expect(tx.expense.aggregate).toHaveBeenCalledWith({
      where: { fecha: { gte: desde, lte: hasta } },
      _sum: { monto: true },
    });
  });

  it('ingresos = 0 → margenBrutoPct = "0.00", nunca NaN/Infinity ni una excepción', async () => {
    const tx = buildMockTx({
      ventasTotal: null,
      devolucionesTotal: null,
      saleItems: [],
      returnItems: [],
      gastosTotal: '15.00',
    });
    const { service } = buildService(tx);

    const result = await service.consultar(query('2026-01-01', '2026-01-31'));

    expect(result.ingresos).toBe('0.00');
    expect(result.margenBrutoPct).toBe('0.00');
    expect(result.resultadoNeto).toBe('-15.00');
  });

  it('desde > hasta → rechaza con BadRequestException "El rango de fechas no es válido", ANTES de ejecutar ninguna query contra Prisma', async () => {
    const tx = buildMockTx();
    const { service, transactionMock } = buildService(tx);

    const call = service.consultar(query('2026-02-15', '2026-01-01'));

    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.consultar(query('2026-02-15', '2026-01-01')),
    ).rejects.toThrow('El rango de fechas no es válido');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(tx.sale.aggregate).not.toHaveBeenCalled();
    expect(tx.return.aggregate).not.toHaveBeenCalled();
    expect(tx.saleItem.findMany).not.toHaveBeenCalled();
    expect(tx.returnItem.findMany).not.toHaveBeenCalled();
    expect(tx.expense.aggregate).not.toHaveBeenCalled();
  });

  it('período sin ninguna venta/devolución/gasto: todos los campos en "0.00", 200 (sin excepción)', async () => {
    const tx = buildMockTx();
    const { service } = buildService(tx);

    const result = await service.consultar(query('2026-01-01', '2026-01-31'));

    expect(result).toEqual(
      expect.objectContaining({
        ingresos: '0.00',
        cmv: '0.00',
        margenBruto: '0.00',
        margenBrutoPct: '0.00',
        gastos: '0.00',
        resultadoNeto: '0.00',
      }),
    );
  });

  it('calculadoEn está presente y es una fecha válida (RN-9: "al día de hoy", no una foto inmutable)', async () => {
    const tx = buildMockTx();
    const { service } = buildService(tx);

    const before = new Date();
    const result = await service.consultar(query('2026-01-01', '2026-01-31'));
    const after = new Date();

    expect(result.calculadoEn).toBeInstanceOf(Date);
    expect(result.calculadoEn.getTime()).toBeGreaterThanOrEqual(
      before.getTime(),
    );
    expect(result.calculadoEn.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('lectura pura en su propia transacción RepeatableRead — mismo patrón que SalesService.reconciliar()/ReturnsService.consultarCredito()', async () => {
    const tx = buildMockTx();
    const { service, transactionMock } = buildService(tx);

    await service.consultar(query('2026-01-01', '2026-01-31'));

    expect(transactionMock).toHaveBeenCalledWith(
      expect.any(Function) as unknown,
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
  });
});

// ─── T6.6 — Fase 04a: tests primero, en sesión aislada ───────────────────
// Fuente única: el ticket T6.6 pasado en el prompt de esta fase (derivado
// de `ROADMAP.md`, la fórmula RN-10 dada textualmente en el prompt, e
// invariantes 11/12). `resultados.service.ts`/`resultados.controller.ts`
// se leyeron tal como existían al cierre de T6.5 — como contrato ya
// cerrado sobre el que este ticket agrega dos métodos nuevos, nunca como
// fuente de SU lógica. `argentinaDayRangeToUtc` (T0.7, ya VERDE) se usa
// real, sin mockear, igual que el resto de este archivo desde T6.5.
//
// ─── Diseño de queries que este bloque fija como contrato ────────────────
// (a implementar en la Fase 04, otra sesión — acá solo se pinnea la FORMA
// exacta que la Fase 04a puede verificar con `toHaveBeenCalledWith`, nunca
// el cálculo interno):
//   `rankingProductos`:
//   - `tx.saleItem.findMany({ where: { sale: { estado: COMPLETADA,
//     fecha: {gte,lte} } }, select: { variantId, descripcionSnapshot,
//     cantidad, netoLinea, costoUnitario } })` — base de unidades/ingresos
//     por producto (mismo filtro 1 que `consultar`).
//   - `tx.returnItem.findMany({ where: { return: { fecha: {gte,lte} } },
//     select: { cantidad, netoLinea, costoUnitario, reingresaStock,
//     saleItem: { select: { variantId } } } })` — TODAS las devoluciones,
//     SIN filtrar por `reingresaStock` en el `where` (a diferencia de
//     `consultar`, que sí lo filtraba para el CMV): acá la condición se
//     aplica en JS, línea por línea, porque afecta el costo pero no las
//     unidades/ingresos (asimetría RN-10). El JOIN a `variantId` pasa por
//     `saleItem.variantId` (`return_items` no tiene `variant_id` propio).
//   `gastosPorCategoria`:
//   - `tx.expense.findMany({ where: { fecha: {gte,lte} }, select: {
//     expenseCategoryId, monto, expenseCategory: { select: { nombre } } } })`.
//
// Ambos abren su PROPIA transacción `RepeatableRead`, mismo contrato que
// `consultar` — no se repiten acá los tests de esa forma estructural para
// no duplicar lo que ya cubre el describe de `consultar` con la misma
// clase; el foco de este bloque es la fórmula/orden/desempate propios de
// T6.6.

interface RankingSaleItemRow {
  variantId: number;
  descripcionSnapshot: string;
  cantidad: number;
  netoLinea: Prisma.Decimal;
  costoUnitario: Prisma.Decimal;
}

interface RankingReturnItemRow {
  cantidad: number;
  netoLinea: Prisma.Decimal;
  costoUnitario: Prisma.Decimal;
  reingresaStock: boolean;
  saleItem: { variantId: number };
}

interface RankingMockTx {
  saleItem: {
    findMany: jest.Mock<Promise<RankingSaleItemRow[]>, [unknown]>;
  };
  returnItem: {
    findMany: jest.Mock<Promise<RankingReturnItemRow[]>, [unknown]>;
  };
}

interface BuildRankingTxOptions {
  saleItems?: Array<{
    variantId: number;
    descripcionSnapshot: string;
    cantidad: number;
    netoLinea: string;
    costoUnitario: string;
  }>;
  returnItems?: Array<{
    variantId: number;
    cantidad: number;
    netoLinea: string;
    costoUnitario: string;
    reingresaStock: boolean;
  }>;
}

function buildRankingMockTx(
  options: BuildRankingTxOptions = {},
): RankingMockTx {
  return {
    saleItem: {
      findMany: jest
        .fn<Promise<RankingSaleItemRow[]>, [unknown]>()
        .mockResolvedValue(
          (options.saleItems ?? []).map((i) => ({
            variantId: i.variantId,
            descripcionSnapshot: i.descripcionSnapshot,
            cantidad: i.cantidad,
            netoLinea: new Prisma.Decimal(i.netoLinea),
            costoUnitario: new Prisma.Decimal(i.costoUnitario),
          })),
        ),
    },
    returnItem: {
      findMany: jest
        .fn<Promise<RankingReturnItemRow[]>, [unknown]>()
        .mockResolvedValue(
          (options.returnItems ?? []).map((i) => ({
            cantidad: i.cantidad,
            netoLinea: new Prisma.Decimal(i.netoLinea),
            costoUnitario: new Prisma.Decimal(i.costoUnitario),
            reingresaStock: i.reingresaStock,
            saleItem: { variantId: i.variantId },
          })),
        ),
    },
  };
}

interface GastosExpenseRow {
  expenseCategoryId: number;
  monto: Prisma.Decimal;
  expenseCategory: { nombre: string };
}

interface GastosMockTx {
  expense: {
    findMany: jest.Mock<Promise<GastosExpenseRow[]>, [unknown]>;
  };
}

function buildGastosMockTx(
  expenses: Array<{
    expenseCategoryId: number;
    monto: string;
    nombre: string;
  }> = [],
): GastosMockTx {
  return {
    expense: {
      findMany: jest
        .fn<Promise<GastosExpenseRow[]>, [unknown]>()
        .mockResolvedValue(
          expenses.map((e) => ({
            expenseCategoryId: e.expenseCategoryId,
            monto: new Prisma.Decimal(e.monto),
            expenseCategory: { nombre: e.nombre },
          })),
        ),
    },
  };
}

// Reusa el mismo tipo `TransactionMock` ya definido arriba para
// `consultar` — genérico sobre cualquier forma de `tx` mockeado.
function buildServiceWithTx<T extends object>(
  tx: T,
): {
  service: ResultadosService;
  transactionMock: TransactionMock;
} {
  const transactionMock: TransactionMock = jest
    .fn<
      Promise<unknown>,
      [
        (t: Prisma.TransactionClient) => unknown,
        { isolationLevel?: Prisma.TransactionIsolationLevel }?,
      ]
    >()
    .mockImplementation((callback) =>
      Promise.resolve(callback(tx as unknown as Prisma.TransactionClient)),
    );
  const prisma = { $transaction: transactionMock } as unknown as PrismaService;
  return { service: new ResultadosService(prisma), transactionMock };
}

function rankingQuery(
  desde: string,
  hasta: string,
  orden?: 'unidades' | 'margen',
): RankingProductosQuery {
  return { desde, hasta, orden };
}

function gastosQuery(desde: string, hasta: string): GastosPorCategoriaQuery {
  return { desde, hasta };
}

describe('ResultadosService.rankingProductos (T6.6)', () => {
  it('camino feliz, orden por unidades (default): dos variantes, calculadas a mano — A (5 unidades) antes que B (2 unidades)', async () => {
    // Variante A (id 10): 1 línea, cantidad 5, netoLinea 250.00,
    //   costoUnitario 20.00 → cmv = 5×20.00 = 100.00 → margen = 150.00.
    // Variante B (id 20): 1 línea, cantidad 2, netoLinea 300.00,
    //   costoUnitario 30.00 → cmv = 2×30.00 = 60.00 → margen = 240.00.
    // Sin devoluciones. Por unidades: A(5) > B(2) → [A, B]. Por margen
    // hubiera dado el orden inverso — B(240) > A(150) — a propósito,
    // para que el siguiente test confirme que el parámetro sí cambia el
    // orden.
    const tx = buildRankingMockTx({
      saleItems: [
        {
          variantId: 10,
          descripcionSnapshot: 'Remera Azul M',
          cantidad: 5,
          netoLinea: '250.00',
          costoUnitario: '20.00',
        },
        {
          variantId: 20,
          descripcionSnapshot: 'Pantalón Negro L',
          cantidad: 2,
          netoLinea: '300.00',
          costoUnitario: '30.00',
        },
      ],
    });
    const { service } = buildServiceWithTx(tx);

    const result = await service.rankingProductos(
      rankingQuery('2026-01-01', '2026-01-31', 'unidades'),
    );

    expect(result).toEqual([
      {
        variantId: 10,
        descripcionSnapshot: 'Remera Azul M',
        unidadesVendidas: 5,
        margenTotal: '150.00',
      },
      {
        variantId: 20,
        descripcionSnapshot: 'Pantalón Negro L',
        unidadesVendidas: 2,
        margenTotal: '240.00',
      },
    ]);
  });

  it('camino feliz, orden por margen: mismos datos que el test anterior — el orden se invierte (B antes que A)', async () => {
    const tx = buildRankingMockTx({
      saleItems: [
        {
          variantId: 10,
          descripcionSnapshot: 'Remera Azul M',
          cantidad: 5,
          netoLinea: '250.00',
          costoUnitario: '20.00',
        },
        {
          variantId: 20,
          descripcionSnapshot: 'Pantalón Negro L',
          cantidad: 2,
          netoLinea: '300.00',
          costoUnitario: '30.00',
        },
      ],
    });
    const { service } = buildServiceWithTx(tx);

    const result = await service.rankingProductos(
      rankingQuery('2026-01-01', '2026-01-31', 'margen'),
    );

    expect(result).toEqual([
      {
        variantId: 20,
        descripcionSnapshot: 'Pantalón Negro L',
        unidadesVendidas: 2,
        margenTotal: '240.00',
      },
      {
        variantId: 10,
        descripcionSnapshot: 'Remera Azul M',
        unidadesVendidas: 5,
        margenTotal: '150.00',
      },
    ]);
  });

  it('orden se omite → default "unidades" (decisión de esta fase, sin marcarlo obligatorio)', async () => {
    const tx = buildRankingMockTx({
      saleItems: [
        {
          variantId: 10,
          descripcionSnapshot: 'Remera Azul M',
          cantidad: 5,
          netoLinea: '250.00',
          costoUnitario: '20.00',
        },
        {
          variantId: 20,
          descripcionSnapshot: 'Pantalón Negro L',
          cantidad: 2,
          netoLinea: '300.00',
          costoUnitario: '30.00',
        },
      ],
    });
    const { service } = buildServiceWithTx(tx);

    const result = await service.rankingProductos({
      desde: '2026-01-01',
      hasta: '2026-01-31',
    });

    // Mismo orden que el test explícito de "unidades" — A(5) antes que
    // B(2) — porque el default, sin pasar `orden`, es "unidades".
    expect(result.map((r) => r.variantId)).toEqual([10, 20]);
  });

  it('devolución reingresaStock: false: baja unidades e ingresos de esa variante, pero el costo (y por lo tanto el margen) NO se ajusta por esa devolución', async () => {
    // Variante C (id 30): 1 línea, cantidad 4, netoLinea 400.00,
    //   costoUnitario 50.00 → cmv base = 4×50.00 = 200.00.
    // Devolución de 1 unidad de esa línea, reingresaStock: false,
    //   netoLinea 100.00, costoUnitario 50.00.
    //   unidadesVendidas = 4 − 1 = 3
    //   ingresos = 400.00 − 100.00 = 300.00
    //   cmv = 200.00 − 0 (NO se revierte: reingresaStock false) = 200.00
    //   margenTotal = 300.00 − 200.00 = 100.00
    const tx = buildRankingMockTx({
      saleItems: [
        {
          variantId: 30,
          descripcionSnapshot: 'Campera Roja S',
          cantidad: 4,
          netoLinea: '400.00',
          costoUnitario: '50.00',
        },
      ],
      returnItems: [
        {
          variantId: 30,
          cantidad: 1,
          netoLinea: '100.00',
          costoUnitario: '50.00',
          reingresaStock: false,
        },
      ],
    });
    const { service } = buildServiceWithTx(tx);

    const result = await service.rankingProductos(
      rankingQuery('2026-01-01', '2026-01-31'),
    );

    expect(result).toEqual([
      {
        variantId: 30,
        descripcionSnapshot: 'Campera Roja S',
        unidadesVendidas: 3,
        margenTotal: '100.00',
      },
    ]);
  });

  it('desempate por variantId ascendente cuando dos variantes empatan en el criterio de orden (unidades)', async () => {
    // Variante D (id 1) y variante E (id 2): ambas con 5 unidades
    // vendidas (empate exacto en "unidades"), márgenes distintos a
    // propósito (450.00 vs 949.00) para confirmar que el desempate es
    // por `variantId`, no por margen ni por ningún otro campo.
    const tx = buildRankingMockTx({
      saleItems: [
        {
          variantId: 1,
          descripcionSnapshot: 'Producto D',
          cantidad: 5,
          netoLinea: '500.00',
          costoUnitario: '10.00',
        },
        {
          variantId: 2,
          descripcionSnapshot: 'Producto E',
          cantidad: 5,
          netoLinea: '999.00',
          costoUnitario: '10.00',
        },
      ],
    });
    const { service } = buildServiceWithTx(tx);

    const result = await service.rankingProductos(
      rankingQuery('2026-01-01', '2026-01-31', 'unidades'),
    );

    expect(result.map((r) => r.variantId)).toEqual([1, 2]);
  });

  it('filtros y AD-13: sale_items filtra por sale.estado COMPLETADA, return_items NO filtra por reingresaStock en el where, y los límites gte/lte salen de argentinaDayRangeToUtc', async () => {
    const tx = buildRankingMockTx();
    const { service } = buildServiceWithTx(tx);
    const { desde } = argentinaDayRangeToUtc('2026-02-01');
    const hastaFin = argentinaDayRangeToUtc('2026-02-28').hasta;

    await service.rankingProductos(rankingQuery('2026-02-01', '2026-02-28'));

    expect(tx.saleItem.findMany).toHaveBeenCalledWith({
      where: {
        sale: {
          estado: SaleEstado.COMPLETADA,
          fecha: { gte: desde, lte: hastaFin },
        },
      },
      select: {
        variantId: true,
        descripcionSnapshot: true,
        cantidad: true,
        netoLinea: true,
        costoUnitario: true,
      },
    });
    expect(tx.returnItem.findMany).toHaveBeenCalledWith({
      where: {
        return: { fecha: { gte: desde, lte: hastaFin } },
      },
      select: {
        cantidad: true,
        netoLinea: true,
        costoUnitario: true,
        reingresaStock: true,
        saleItem: { select: { variantId: true } },
      },
    });
  });

  it('desde > hasta → rechaza con BadRequestException "El rango de fechas no es válido", sin ejecutar ninguna query', async () => {
    const tx = buildRankingMockTx();
    const { service, transactionMock } = buildServiceWithTx(tx);

    const call = service.rankingProductos(
      rankingQuery('2026-02-15', '2026-01-01'),
    );

    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.rankingProductos(rankingQuery('2026-02-15', '2026-01-01')),
    ).rejects.toThrow('El rango de fechas no es válido');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(tx.saleItem.findMany).not.toHaveBeenCalled();
    expect(tx.returnItem.findMany).not.toHaveBeenCalled();
  });

  it('período sin ventas: array vacío, 200 (sin excepción)', async () => {
    const tx = buildRankingMockTx();
    const { service } = buildServiceWithTx(tx);

    const result = await service.rankingProductos(
      rankingQuery('2026-01-01', '2026-01-31'),
    );

    expect(result).toEqual([]);
  });
});

describe('ResultadosService.gastosPorCategoria (T6.6)', () => {
  it('camino feliz: dos categorías, calculadas a mano — ordenado descendente por total', async () => {
    // Categoría A (id 100, "Alquiler"): dos gastos, 500.00 + 300.00 =
    //   800.00.
    // Categoría B (id 200, "Servicios"): un gasto, 1000.00.
    // Orden esperado por total descendente: B (1000.00) antes que A
    //   (800.00).
    const tx = buildGastosMockTx([
      { expenseCategoryId: 100, monto: '500.00', nombre: 'Alquiler' },
      { expenseCategoryId: 100, monto: '300.00', nombre: 'Alquiler' },
      { expenseCategoryId: 200, monto: '1000.00', nombre: 'Servicios' },
    ]);
    const { service } = buildServiceWithTx(tx);

    const result = await service.gastosPorCategoria(
      gastosQuery('2026-01-01', '2026-01-31'),
    );

    expect(result).toEqual([
      { expenseCategoryId: 200, nombre: 'Servicios', total: '1000.00' },
      { expenseCategoryId: 100, nombre: 'Alquiler', total: '800.00' },
    ]);
  });

  it('desempate por nombre ascendente cuando dos categorías empatan en total', async () => {
    // Categoría "Impuestos" (id 1) y categoría "Alquiler" (id 2): mismo
    // total (500.00 cada una) — el desempate es por `nombre` ascendente,
    // "Alquiler" antes que "Impuestos", sin importar el id.
    const tx = buildGastosMockTx([
      { expenseCategoryId: 1, monto: '500.00', nombre: 'Impuestos' },
      { expenseCategoryId: 2, monto: '500.00', nombre: 'Alquiler' },
    ]);
    const { service } = buildServiceWithTx(tx);

    const result = await service.gastosPorCategoria(
      gastosQuery('2026-01-01', '2026-01-31'),
    );

    expect(result).toEqual([
      { expenseCategoryId: 2, nombre: 'Alquiler', total: '500.00' },
      { expenseCategoryId: 1, nombre: 'Impuestos', total: '500.00' },
    ]);
  });

  it('filtro y AD-13: los límites gte/lte que llegan a la query de gastos salen de argentinaDayRangeToUtc', async () => {
    const tx = buildGastosMockTx();
    const { service } = buildServiceWithTx(tx);
    const desde = argentinaDayRangeToUtc('2026-03-01').desde;
    const hasta = argentinaDayRangeToUtc('2026-03-31').hasta;

    await service.gastosPorCategoria(gastosQuery('2026-03-01', '2026-03-31'));

    expect(tx.expense.findMany).toHaveBeenCalledWith({
      where: { fecha: { gte: desde, lte: hasta } },
      select: {
        expenseCategoryId: true,
        monto: true,
        expenseCategory: { select: { nombre: true } },
      },
    });
  });

  it('desde > hasta → rechaza con BadRequestException "El rango de fechas no es válido", sin ejecutar ninguna query', async () => {
    const tx = buildGastosMockTx();
    const { service, transactionMock } = buildServiceWithTx(tx);

    const call = service.gastosPorCategoria(
      gastosQuery('2026-02-15', '2026-01-01'),
    );

    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.gastosPorCategoria(gastosQuery('2026-02-15', '2026-01-01')),
    ).rejects.toThrow('El rango de fechas no es válido');
    expect(transactionMock).not.toHaveBeenCalled();
    expect(tx.expense.findMany).not.toHaveBeenCalled();
  });

  it('período sin gastos: array vacío, 200 (sin excepción)', async () => {
    const tx = buildGastosMockTx();
    const { service } = buildServiceWithTx(tx);

    const result = await service.gastosPorCategoria(
      gastosQuery('2026-01-01', '2026-01-31'),
    );

    expect(result).toEqual([]);
  });
});
