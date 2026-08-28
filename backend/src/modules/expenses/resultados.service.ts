import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, SaleEstado } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { argentinaDayRangeToUtc } from '../../common/timezone/argentina-timezone.util';

// Forma de la respuesta de `GET /resultados` — spec del módulo,
// sección 4. Todos los importes viajan como `string` (`Decimal`,
// BLUEPRINT §9.3), nunca `number`.
export interface ResultadosQuery {
  desde: string;
  hasta: string;
}

export interface ResultadosResponse {
  ingresos: string;
  cmv: string;
  margenBruto: string;
  margenBrutoPct: string;
  gastos: string;
  resultadoNeto: string;
  calculadoEn: Date;
  periodo: { desde: string; hasta: string };
}

// T6.6 — `GET /resultados/ranking-productos`. `orden` opcional: default
// 'unidades' cuando se omite (decisión de esta fase, la spec no lo marca
// obligatorio explícitamente).
export interface RankingProductosQuery {
  desde: string;
  hasta: string;
  orden?: 'unidades' | 'margen';
}

export interface RankingProductoItem {
  variantId: number;
  descripcionSnapshot: string;
  unidadesVendidas: number;
  margenTotal: string;
}

// T6.6 — `GET /resultados/gastos-por-categoria`.
export interface GastosPorCategoriaQuery {
  desde: string;
  hasta: string;
}

export interface GastoPorCategoriaItem {
  expenseCategoryId: number;
  nombre: string;
  total: string;
}

// Redondeo comercial (medio hacia arriba) a 2 decimales — mismo criterio
// que `roundCurrency` de `common/money/money.util.ts`. No se reusa esa
// función tal cual porque acá también se aplica a `margenBrutoPct`, que
// no es estrictamente un importe de dinero (es un cociente ×100), pero
// se muestra con la misma precisión.
function round2(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

function money(value: Prisma.Decimal): string {
  return round2(value).toFixed(2);
}

// T6.4 (BLUEPRINT §5.6) + T6.5 (AD-13) — ingresos, CMV, margen bruto (y
// su %), gastos y resultado neto de un rango de fechas. Lectura pura,
// sin `tx` recibido de ningún controller — abre su PROPIA transacción
// `RepeatableRead` (mismo contrato que `SalesService.reconciliar()`/
// `ReturnsService.consultarCredito()`: no compone con la transacción de
// nadie más, y sin `RepeatableRead` una escritura real entre dos
// lecturas del cálculo podría dar un número que nunca existió en ningún
// instante consistente).
//
// T6.5: `desde`/`hasta` se interpretan en hora argentina (AD-13, vía
// `argentinaDayRangeToUtc`, T0.7) — el `gte` es la medianoche del día
// `desde` en Argentina, el `lte` es el 23:59:59.999 del día `hasta` en
// Argentina, ambos ya convertidos a UTC (dos cálculos independientes,
// no el mismo día aplicado a los dos extremos, para que un rango de
// varios días tome el inicio del primero y el fin del último). Filtra
// siempre por la fecha de la CABECERA (`sales.fecha`/`returns.fecha`/
// `expenses.fecha`), nunca por `created_at` de las tablas de ítems —
// esa parte ya era correcta desde T6.4.
@Injectable()
export class ResultadosService {
  constructor(private readonly prisma: PrismaService) {}

  async consultar(query: ResultadosQuery): Promise<ResultadosResponse> {
    const desde = argentinaDayRangeToUtc(query.desde).desde;
    const hasta = argentinaDayRangeToUtc(query.hasta).hasta;

    if (desde.getTime() > hasta.getTime()) {
      throw new BadRequestException('El rango de fechas no es válido');
    }

    const rango = { gte: desde, lte: hasta };

    const [ventasAgg, devolucionesAgg, saleItems, returnItems, gastosAgg] =
      await this.prisma.$transaction(
        (tx) =>
          Promise.all([
            // Filtro 1: solo ventas COMPLETADA — igual que la base del
            // CMV, nunca por separado (BLUEPRINT §5.6, filtro 1).
            tx.sale.aggregate({
              where: { estado: SaleEstado.COMPLETADA, fecha: rango },
              _sum: { total: true },
            }),
            // `Return` no tiene `estado` propio — "las devoluciones no
            // se anulan" (BLUEPRINT §5.6).
            tx.return.aggregate({
              where: { fecha: rango },
              _sum: { totalDevuelto: true },
            }),
            // Base del CMV — JOIN a la cabecera de venta (filtro 1 +
            // filtro 3 estructural: se filtra por `sale.fecha`, nunca
            // por el `created_at` de la línea).
            tx.saleItem.findMany({
              where: { sale: { estado: SaleEstado.COMPLETADA, fecha: rango } },
              select: { cantidad: true, costoUnitario: true },
            }),
            // Reversión del CMV — filtro 2: solo líneas que reingresaron
            // stock (una devolución de mercadería fallada resta el
            // ingreso pero el costo queda, BLUEPRINT §5.6, filtro 2).
            tx.returnItem.findMany({
              where: { reingresaStock: true, return: { fecha: rango } },
              select: { cantidad: true, costoUnitario: true },
            }),
            // Gastos del período — nunca incluye compra de mercadería:
            // ya garantizado por AD-7/T6.1 (no existe una categoría de
            // gasto para eso), no hace falta un filtro nuevo acá.
            tx.expense.aggregate({
              where: { fecha: rango },
              _sum: { monto: true },
            }),
          ]),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

    const ventasTotal = ventasAgg._sum.total ?? new Prisma.Decimal(0);
    const devolucionesTotal =
      devolucionesAgg._sum.totalDevuelto ?? new Prisma.Decimal(0);
    const ingresos = ventasTotal.minus(devolucionesTotal);

    // `cantidad × costoUnitario` no es una columna — se suma en JS con
    // `Decimal`, mismo criterio que `lineSubtotal`/`prorate` de
    // `common/money/money.util.ts` (nunca con `number`).
    const cmvVentas = saleItems.reduce(
      (acc, item) => acc.plus(item.costoUnitario.times(item.cantidad)),
      new Prisma.Decimal(0),
    );
    const cmvDevoluciones = returnItems.reduce(
      (acc, item) => acc.plus(item.costoUnitario.times(item.cantidad)),
      new Prisma.Decimal(0),
    );
    const cmv = cmvVentas.minus(cmvDevoluciones);

    const margenBruto = ingresos.minus(cmv);
    const margenBrutoPct = ingresos.isZero()
      ? new Prisma.Decimal(0)
      : margenBruto.dividedBy(ingresos).times(100);

    const gastos = gastosAgg._sum.monto ?? new Prisma.Decimal(0);
    const resultadoNeto = margenBruto.minus(gastos);

    return {
      ingresos: money(ingresos),
      cmv: money(cmv),
      margenBruto: money(margenBruto),
      margenBrutoPct: money(margenBrutoPct),
      gastos: money(gastos),
      resultadoNeto: money(resultadoNeto),
      calculadoEn: new Date(),
      periodo: { desde: query.desde, hasta: query.hasta },
    };
  }

  // T6.6 — stub mínimo de esta fase (04a): fija el contrato de tipos e
  // implementación mínima para que compile y falle correctamente. La
  // fórmula/queries reales (RN-10, spec del ticket) se implementan en
  // otra sesión (Fase 04) contra los tests que este mismo commit deja en
  // rojo — mismo patrón de stub ya usado en T6.2/T6.4.
  async rankingProductos(
    _query: RankingProductosQuery,
  ): Promise<RankingProductoItem[]> {
    return Promise.reject(new Error('T6.6 todavía no implementado'));
  }

  // T6.6 — mismo criterio de stub que `rankingProductos`.
  async gastosPorCategoria(
    _query: GastosPorCategoriaQuery,
  ): Promise<GastoPorCategoriaItem[]> {
    return Promise.reject(new Error('T6.6 todavía no implementado'));
  }
}
