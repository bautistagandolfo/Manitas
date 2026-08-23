import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  PriceHistoryCampo,
  PriceHistoryOrigen,
  Variant,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { UpdateVariantPriceDto } from './dto/update-variant-price.dto';

// RN-3 (BLUEPRINT §5.2, literal): el costo solo lo ve OWNER. Se resuelve
// acá (no con `omit` en la query de Prisma) porque la condición es
// dinámica según quién pregunta — más simple de auditar que un `omit`
// con una variable booleana, que Prisma no puede reflejar en el tipo de
// retorno.
export type VariantForRole = Omit<Variant, 'costoActual'> & {
  costoActual?: Prisma.Decimal;
};

function hideOwnerOnlyFields(
  variant: Variant,
  isOwner: boolean,
): VariantForRole {
  if (isOwner) {
    return variant;
  }
  const stripped: VariantForRole = { ...variant };
  delete stripped.costoActual;
  return stripped;
}

function violatedConstraint(
  error: Prisma.PrismaClientKnownRequestError,
): string {
  const target = error.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  return '';
}

@Injectable()
export class VariantsService {
  constructor(private readonly prisma: PrismaService) {}

  async findOne(id: number, isOwner: boolean): Promise<VariantForRole> {
    const variant = await this.prisma.variant.findUnique({ where: { id } });

    if (!variant) {
      throw new NotFoundException('Variante no encontrada');
    }

    return hideOwnerOnlyFields(variant, isOwner);
  }

  // OWNER-only a nivel de ruta (AMB-11) — no hace falta re-chequear el rol
  // acá, pero el costo siempre viaja en la respuesta porque quien llega
  // hasta este método ya es OWNER.
  async create(
    productId: number,
    dto: CreateVariantDto,
    userId: number,
  ): Promise<Variant> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    const precioVenta = new Prisma.Decimal(dto.precioVenta);
    const costoActual = new Prisma.Decimal(dto.costoActual);
    this.assertPositive(precioVenta, 'precioVenta');
    this.assertPositive(costoActual, 'costoActual');

    try {
      // AD-16 / RN-10: toda alta de variante deja su precio y costo
      // iniciales en price_history con origen ALTA (valorAnterior null) —
      // en la misma transacción que la creación, no como un paso aparte.
      return await this.prisma.$transaction(async (tx) => {
        const variant = await tx.variant.create({
          data: {
            productId,
            sizeId: dto.sizeId,
            colorId: dto.colorId,
            sku: dto.sku,
            barcode: dto.barcode,
            precioVenta,
            costoActual,
          },
        });

        await tx.priceHistory.createMany({
          data: [
            {
              variantId: variant.id,
              campo: PriceHistoryCampo.PRECIO_VENTA,
              valorAnterior: null,
              valorNuevo: precioVenta,
              origen: PriceHistoryOrigen.ALTA,
              userId,
            },
            {
              variantId: variant.id,
              campo: PriceHistoryCampo.COSTO,
              valorAnterior: null,
              valorNuevo: costoActual,
              origen: PriceHistoryOrigen.ALTA,
              userId,
            },
          ],
        });

        return variant;
      });
    } catch (error) {
      throw this.translateWriteError(error);
    }
  }

  async update(
    id: number,
    dto: UpdateVariantDto,
    isOwner: boolean,
  ): Promise<VariantForRole> {
    try {
      const variant = await this.prisma.variant.update({
        where: { id },
        data: dto,
      });
      return hideOwnerOnlyFields(variant, isOwner);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Variante no encontrada');
      }
      throw this.translateWriteError(error);
    }
  }

  // OWNER-only a nivel de ruta (AMB-11). Endpoint separado de `update()`
  // — no un campo más de UpdateVariantDto — porque cambiar el precio
  // siempre escribe price_history (AD-16), en la misma transacción.
  async updatePrice(
    id: number,
    dto: UpdateVariantPriceDto,
    userId: number,
  ): Promise<Variant> {
    const nuevoPrecio = new Prisma.Decimal(dto.precioVenta);
    this.assertPositive(nuevoPrecio, 'precioVenta');

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.variant.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Variante no encontrada');
      }

      const updated = await tx.variant.update({
        where: { id },
        data: { precioVenta: nuevoPrecio },
      });

      await tx.priceHistory.create({
        data: {
          variantId: id,
          campo: PriceHistoryCampo.PRECIO_VENTA,
          valorAnterior: current.precioVenta,
          valorNuevo: nuevoPrecio,
          origen: PriceHistoryOrigen.MANUAL,
          userId,
        },
      });

      return updated;
    });
  }

  private assertPositive(value: Prisma.Decimal, field: string): void {
    if (value.lessThanOrEqualTo(0)) {
      throw new BadRequestException(`${field} tiene que ser mayor a 0`);
    }
  }

  private translateWriteError(error: unknown): unknown {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return error;
    }

    if (error.code === 'P2003') {
      return new BadRequestException('El talle o color indicado no existe');
    }

    if (error.code === 'P2002') {
      const target = violatedConstraint(error);
      if (target.includes('sku')) {
        return new ConflictException('Ya existe una variante con ese SKU');
      }
      if (target.includes('barcode')) {
        return new ConflictException(
          'Ya existe una variante con ese código de barras',
        );
      }
      if (target.includes('product') || target.includes('color')) {
        return new ConflictException(
          'Ya existe una variante con ese talle y color para este producto',
        );
      }
      return new ConflictException('Ya existe una variante con esos datos');
    }

    return error;
  }
}
