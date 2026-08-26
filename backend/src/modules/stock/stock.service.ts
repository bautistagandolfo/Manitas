import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  PriceHistoryCampo,
  PriceHistoryOrigen,
  StockMovementReferenciaTipo,
  StockMovementTipo,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// Único punto del sistema que escribe stock_movements y toca stock_actual
// (BLUEPRINT §9.2, CLAUDE.md regla 4). Todos los métodos reciben el `tx` de
// una transacción ya abierta por quien llama — nunca abren la suya propia
// (contrato de modulo-products-variants-spec.md, sección 4.2): en `sales`,
// el descuento de stock es un paso más dentro de la transacción completa de
// la venta, no una operación aislada.

export interface RegistrarEntradaInput {
  variantId: number;
  cantidad: number;
  costoUnitario: Prisma.Decimal.Value;
  userId: number;
}

export interface RegistrarAjusteInput {
  variantId: number;
  delta: number;
  motivo: string;
  userId: number;
}

// T4.1 (`sales`) — método reservado desde la fase 06 de este mismo módulo
// (`modulo-products-variants-spec.md`, sección 4.2: "Expuesto para
// sales/returns, no se llama desde este módulo") pero nunca construido
// hasta ahora. `sales.service.ts` es quien toma el lock de las variantes
// involucradas (ordenado por id, BLUEPRINT §9.4) UNA sola vez para toda la
// venta, antes de llamar a este método por línea — por eso no hay ningún
// `SELECT ... FOR UPDATE` acá adentro, a diferencia de
// `registrarAjuste`, que sí lo toma porque se invoca de forma aislada.
export interface DescontarPorVentaInput {
  variantId: number;
  cantidad: number;
  saleId: number;
  userId: number;
  // `sales.service.ts` decide este valor leyendo `permitir_venta_sin_stock`
  // de `SettingsService` — este método nunca lee configuración por su
  // cuenta, solo lo aplica mecánicamente (mismo principio que RN-9 de
  // `cash-registers`: quien tiene el contexto de negocio decide, el
  // servicio de más abajo confía en lo que le pasan).
  permitirStockNegativo: boolean;
}

// T4.7 (`sales`) — método reservado desde la fase 06 de `sales`
// (`modulo-sales-spec.md`, sección 4.2) para revertir el descuento de
// stock de una venta anulada. Sin lock propio, mismo criterio que
// `registrarEntrada`: revertir siempre suma, nunca necesita validar
// contra un umbral, Postgres serializa el `UPDATE` por sí solo.
export interface RevertirPorAnulacionInput {
  variantId: number;
  cantidad: number;
  saleId: number;
  userId: number;
}

// T5.2 (`returns`) — método reservado desde la fase 06 de `returns`
// (`modulo-returns-spec.md`, sección 5, paso 12) para reingresar al
// stock vendible la mercadería de una devolución, solo cuando la
// prenda vuelve en condiciones de venta (`reingresa_stock = true` por
// línea — si es `false`, `returns.service.ts` ni siquiera llama a
// este método). Sin lock propio, mismo criterio que
// `revertirPorAnulacion`: reingresar siempre suma, nunca necesita
// validar contra un umbral.
export interface ReingresarPorDevolucionInput {
  variantId: number;
  cantidad: number;
  returnId: number;
  userId: number;
}

export interface StockReconciliationMismatch {
  variantId: number;
  stockActual: number;
  sumaMovimientos: number;
}

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  // ENTRADA: delta siempre positivo, nunca valida contra un umbral — un
  // incremento atómico alcanza, Postgres serializa por sí solo los UPDATE
  // concurrentes sobre la misma fila (modulo-products-variants-spec.md,
  // sección 5). Actualiza costo_actual al costo de esta entrada (AD-6,
  // costeo por último costo) y dej a el rastro en price_history (AD-16,
  // RN-10 — todo cambio de costo, incluido por ingreso de mercadería,
  // se audita).
  async registrarEntrada(
    tx: Prisma.TransactionClient,
    input: RegistrarEntradaInput,
  ): Promise<void> {
    const costoUnitario = new Prisma.Decimal(input.costoUnitario);
    const current = await tx.variant.findUniqueOrThrow({
      where: { id: input.variantId },
    });

    await tx.stockMovement.create({
      data: {
        variantId: input.variantId,
        delta: input.cantidad,
        tipo: StockMovementTipo.ENTRADA,
        costoUnitario,
        userId: input.userId,
      },
    });

    await tx.variant.update({
      where: { id: input.variantId },
      data: {
        stockActual: { increment: input.cantidad },
        costoActual: costoUnitario,
      },
    });

    await tx.priceHistory.create({
      data: {
        variantId: input.variantId,
        campo: PriceHistoryCampo.COSTO,
        valorAnterior: current.costoActual,
        valorNuevo: costoUnitario,
        origen: PriceHistoryOrigen.INGRESO_MERCADERIA,
        userId: input.userId,
      },
    });
  }

  // AJUSTE: motivo siempre obligatorio (RN-5, invariante 6), delta puede
  // ser positivo o negativo. Si es negativo, sí necesita
  // SELECT ... FOR UPDATE — hay que leer stock_actual, validar que el
  // resultado no quede negativo (invariante 5; sin la excepción de
  // permitir_venta_sin_stock, que es de `sales`, no de un ajuste manual —
  // RN-5) y escribir, todo bajo el mismo lock, o dos ajustes negativos
  // concurrentes pueden leer el mismo stock_actual y las dos pasar la
  // validación (BLUEPRINT §7/§9.4).
  async registrarAjuste(
    tx: Prisma.TransactionClient,
    input: RegistrarAjusteInput,
  ): Promise<void> {
    const motivo = input.motivo.trim();
    if (!motivo) {
      throw new BadRequestException('El ajuste de stock necesita un motivo');
    }

    if (input.delta >= 0) {
      await tx.stockMovement.create({
        data: {
          variantId: input.variantId,
          delta: input.delta,
          tipo: StockMovementTipo.AJUSTE,
          motivo,
          userId: input.userId,
        },
      });
      await tx.variant.update({
        where: { id: input.variantId },
        data: { stockActual: { increment: input.delta } },
      });
      return;
    }

    // Bloquea la fila primero (BLUEPRINT §9.4), y recién con el lock
    // tomado lee stock_actual con una consulta Prisma normal — dentro de
    // la misma transacción, esa lectura ya ve el valor consistente que el
    // lock garantiza, sin necesitar traer la columna a mano por SQL crudo.
    await tx.$queryRaw`SELECT id FROM variants WHERE id = ${input.variantId} FOR UPDATE`;
    const current = await tx.variant.findUniqueOrThrow({
      where: { id: input.variantId },
    });
    const resultante = current.stockActual + input.delta;

    if (resultante < 0) {
      throw new ConflictException(
        `No podés ajustar a ${resultante}: quedan ${current.stockActual} unidades`,
      );
    }

    await tx.stockMovement.create({
      data: {
        variantId: input.variantId,
        delta: input.delta,
        tipo: StockMovementTipo.AJUSTE,
        motivo,
        userId: input.userId,
      },
    });
    await tx.variant.update({
      where: { id: input.variantId },
      data: { stockActual: { increment: input.delta } },
    });
  }

  // T4.1 — descuento de stock por línea de venta (BLUEPRINT §5.3 paso 6,
  // literal: "un stock_movements con delta negativo por línea"). Sin lock
  // propio (ver el comentario de `DescontarPorVentaInput`) — el `tx` ya
  // llega con la fila de la variante bloqueada por `sales.service.ts`, así
  // que esta lectura ve el valor consistente sin necesitar tomarlo de
  // nuevo. Mismo criterio de validación que `registrarAjuste` con delta
  // negativo (invariante 5), salvo que acá la excepción de
  // `permitir_venta_sin_stock` sí puede aplicar — es responsabilidad de
  // `sales`, no de un ajuste manual (RN-5 de la spec de `products`).
  async descontarPorVenta(
    tx: Prisma.TransactionClient,
    input: DescontarPorVentaInput,
  ): Promise<void> {
    const current = await tx.variant.findUniqueOrThrow({
      where: { id: input.variantId },
    });
    const resultante = current.stockActual - input.cantidad;

    if (resultante < 0 && !input.permitirStockNegativo) {
      throw new ConflictException(
        `Stock insuficiente: quedan ${current.stockActual} unidades`,
      );
    }

    await tx.stockMovement.create({
      data: {
        variantId: input.variantId,
        delta: -input.cantidad,
        tipo: StockMovementTipo.VENTA,
        referenciaTipo: StockMovementReferenciaTipo.SALE,
        referenciaId: input.saleId,
        userId: input.userId,
      },
    });

    await tx.variant.update({
      where: { id: input.variantId },
      data: { stockActual: { decrement: input.cantidad } },
    });
  }

  // T4.7 (`sales`) — reversión de stock por anulación de venta (BLUEPRINT
  // AD-19, RN-8 de `modulo-sales-spec.md`). `sales.service.ts` llama a
  // este método una vez por línea de la venta anulada, sin agregar
  // cantidades por variante (a diferencia de `descontarPorVenta`, acá no
  // hay validación de umbral que agregar).
  async revertirPorAnulacion(
    tx: Prisma.TransactionClient,
    input: RevertirPorAnulacionInput,
  ): Promise<void> {
    await tx.stockMovement.create({
      data: {
        variantId: input.variantId,
        delta: input.cantidad,
        tipo: StockMovementTipo.ANULACION,
        referenciaTipo: StockMovementReferenciaTipo.SALE,
        referenciaId: input.saleId,
        userId: input.userId,
      },
    });

    await tx.variant.update({
      where: { id: input.variantId },
      data: { stockActual: { increment: input.cantidad } },
    });
  }

  // T5.2 (`returns`) — reingreso de stock por devolución (BLUEPRINT §5.4,
  // RN-6 de `modulo-returns-spec.md`). `returns.service.ts` llama a este
  // método una vez por línea con `reingresa_stock = true`, después de
  // crear la devolución (recién ahí existe `return.id`) — nunca para las
  // líneas donde la prenda volvió fallada.
  async reingresarPorDevolucion(
    tx: Prisma.TransactionClient,
    input: ReingresarPorDevolucionInput,
  ): Promise<void> {
    await tx.stockMovement.create({
      data: {
        variantId: input.variantId,
        delta: input.cantidad,
        tipo: StockMovementTipo.DEVOLUCION,
        referenciaTipo: StockMovementReferenciaTipo.RETURN,
        referenciaId: input.returnId,
        userId: input.userId,
      },
    });

    await tx.variant.update({
      where: { id: input.variantId },
      data: { stockActual: { increment: input.cantidad } },
    });
  }

  // T2.8 — invariante 1 (BLUEPRINT §6.1): stock_actual == SUM(delta) para
  // cada variante. Recorre TODAS las variantes, activas o no: RN-7 exige
  // que una variante dada de baja con stock > 0 siga contando en la
  // reconciliación. Devuelve solo las filas que no cuadran — vacío
  // significa reconciliado.
  //
  // Las dos lecturas van dentro de la misma transacción, en REPEATABLE READ:
  // sin eso, cualquier escritura real que ocurra entre una consulta y la
  // otra (un ingreso de mercadería de otra sesión, por ejemplo) puede dejar
  // a las dos consultas viendo un instante distinto del sistema y reportar
  // un desajuste que en realidad nunca existió. Es de solo lectura — no
  // compite con el contrato de la sección 4.2 (ese es solo para quien
  // escribe stock).
  async reconciliar(): Promise<StockReconciliationMismatch[]> {
    const [variants, sums] = await this.prisma.$transaction(
      (tx) =>
        Promise.all([
          tx.variant.findMany({ select: { id: true, stockActual: true } }),
          tx.stockMovement.groupBy({
            by: ['variantId'],
            _sum: { delta: true },
          }),
        ]),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const sumaPorVariante = new Map(
      sums.map((s) => [s.variantId, s._sum.delta ?? 0]),
    );

    return variants
      .filter((v) => v.stockActual !== (sumaPorVariante.get(v.id) ?? 0))
      .map((v) => ({
        variantId: v.id,
        stockActual: v.stockActual,
        sumaMovimientos: sumaPorVariante.get(v.id) ?? 0,
      }));
  }
}
