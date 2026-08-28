import { BadRequestException } from '@nestjs/common';
import { Prisma, SaleEstado } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ResultadosService, ResultadosQuery } from './resultados.service';

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
// Los límites `gte`/`lte` son SIEMPRE `desde 00:00:00.000Z` / `hasta
// 23:59:59.999Z`, UTC ingenuo, sin ajuste de hora argentina (AD-13 es
// T6.5/T0.7, explícitamente fuera de alcance acá — mismo criterio ya
// documentado en `ExpensesService.findAll`, T6.2→T6.3).
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
    const desde = new Date('2026-02-01T00:00:00.000Z');
    const hasta = new Date('2026-02-28T23:59:59.999Z');

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
    const desde = new Date('2026-03-01T00:00:00.000Z');
    const hasta = new Date('2026-03-31T23:59:59.999Z');

    await service.consultar(query('2026-03-01', '2026-03-31'));

    expect(tx.returnItem.findMany).toHaveBeenCalledWith({
      where: {
        reingresaStock: true,
        return: { fecha: { gte: desde, lte: hasta } },
      },
      select: { cantidad: true, costoUnitario: true },
    });
  });

  it('filtro 3, mitad estructural (sin ajuste de hora argentina — eso es T6.5): desde/hasta se interpretan como límites UTC ingenuos, desde 00:00:00.000Z hasta hasta 23:59:59.999Z, y así llegan también a la query de gastos y de devoluciones', async () => {
    const tx = buildMockTx();
    const { service } = buildService(tx);
    const desde = new Date('2026-05-10T00:00:00.000Z');
    const hasta = new Date('2026-05-10T23:59:59.999Z');

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
