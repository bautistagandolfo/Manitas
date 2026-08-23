import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  Prisma,
  PriceHistoryCampo,
  PriceHistoryOrigen,
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
}
