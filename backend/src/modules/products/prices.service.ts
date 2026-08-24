import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, PriceHistoryCampo, PriceHistoryOrigen } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { applyPercentage } from '../../common/money/money.util';
import {
  BulkPriceUpdateDto,
  BulkPriceUpdateFiltroDto,
} from './dto/bulk-price-update.dto';

// RN-9 (BLUEPRINT §5.2, A5): actualización masiva de precios por
// porcentaje, con vista previa obligatoria antes de aplicar. Solo OWNER
// (a nivel de ruta — este servicio no vuelve a chequear el rol).
export interface BulkPriceUpdateItem {
  variantId: number;
  sku: string;
  precioActual: Prisma.Decimal;
  precioResultante: Prisma.Decimal;
}

interface MatchedVariant {
  id: number;
  sku: string;
  precioVenta: Prisma.Decimal;
}

// Subconjunto de Prisma.TransactionClient/PrismaService que necesita la
// consulta de variantes — permite reusar la misma lógica de matching
// tanto para el preview (lectura suelta, no escribe nada) como para
// apply (misma lectura, pero dentro de la transacción que también
// escribe).
type VariantReader = Pick<Prisma.TransactionClient, 'variant'>;

@Injectable()
export class PricesService {
  constructor(private readonly prisma: PrismaService) {}

  // Sin `Idempotency-Key`: decisión del PO (2026-08-23, mismo criterio
  // que T2.5/`/stock/entradas` — ver `ROADMAP.md`). Acá el motivo es más
  // fuerte todavía: `price_history` no tiene columna `idempotency_key`
  // (igual que `stock_movements`), y el mecanismo de T0.14
  // (`withIdempotency`, capturar P2002 sobre una columna única) está
  // pensado para una fila por operación — acá una sola aplicación escribe
  // N filas, una por variante afectada, así que ni siquiera encajaría sin
  // rediseñar el mecanismo. Riesgo de doble click (aplicar el mismo
  // aumento dos veces) aceptado conscientemente.
  async apply(
    dto: BulkPriceUpdateDto,
    userId: number,
  ): Promise<BulkPriceUpdateItem[]> {
    return this.prisma.$transaction(async (tx) => {
      const variants = await this.matchingVariants(tx, dto.filtro);
      const resultado = this.computeResultado(variants, dto.porcentaje);

      for (const item of resultado) {
        await tx.variant.update({
          where: { id: item.variantId },
          data: { precioVenta: item.precioResultante },
        });
        await tx.priceHistory.create({
          data: {
            variantId: item.variantId,
            campo: PriceHistoryCampo.PRECIO_VENTA,
            valorAnterior: item.precioActual,
            valorNuevo: item.precioResultante,
            origen: PriceHistoryOrigen.MASIVO,
            userId,
          },
        });
      }

      return resultado;
    });
  }

  // No escribe nada (RN-9, literal) — una sola lectura suelta, sin
  // transacción, alcanza.
  async preview(dto: BulkPriceUpdateDto): Promise<BulkPriceUpdateItem[]> {
    const variants = await this.matchingVariants(this.prisma, dto.filtro);
    return this.computeResultado(variants, dto.porcentaje);
  }

  // BLUEPRINT §6, edge case "Actualización masiva sobre variantes
  // inactivas": se excluyen del filtro por defecto (no tiene sentido
  // remarcar algo que no se vende), **salvo que el filtro sea por
  // selección manual explícita de ids — ahí se respeta la selección tal
  // cual**, es una decisión consciente de quien la hizo. Encontrado sin
  // implementar en la Fase 07 (cierre del módulo): la versión anterior
  // filtraba `activo: true` siempre, incluso con `variantIds` explícito.
  private async matchingVariants(
    reader: VariantReader,
    filtro: BulkPriceUpdateFiltroDto,
  ): Promise<MatchedVariant[]> {
    if (filtro.variantIds !== undefined) {
      return reader.variant.findMany({
        where: { id: { in: filtro.variantIds } },
        select: { id: true, sku: true, precioVenta: true },
        orderBy: { sku: 'asc' },
      });
    }

    const productWhere: Prisma.ProductWhereInput = {
      activo: true,
      ...(filtro.brandId !== undefined && { brandId: filtro.brandId }),
      ...(filtro.categoryId !== undefined && { categoryId: filtro.categoryId }),
    };

    return reader.variant.findMany({
      where: { activo: true, product: productWhere },
      select: { id: true, sku: true, precioVenta: true },
      orderBy: { sku: 'asc' },
    });
  }

  // Regla 3 de §9.3: el porcentaje se calcula sobre la base y se redondea
  // a 2 decimales antes de sumarse — `applyPercentage` ya hace ese
  // redondeo, así que la suma queda automáticamente en 2 decimales, sin
  // necesidad de un segundo `roundCurrency`.
  private computeResultado(
    variants: MatchedVariant[],
    porcentaje: string,
  ): BulkPriceUpdateItem[] {
    return variants.map((variant) => {
      const precioActual = variant.precioVenta;
      const precioResultante = precioActual.plus(
        applyPercentage(precioActual, porcentaje),
      );

      if (precioResultante.lessThanOrEqualTo(0)) {
        throw new BadRequestException(
          `El porcentaje dejaría a ${variant.sku} en ${precioResultante.toString()}: precioVenta tiene que ser mayor a 0`,
        );
      }

      return {
        variantId: variant.id,
        sku: variant.sku,
        precioActual,
        precioResultante,
      };
    });
  }
}
