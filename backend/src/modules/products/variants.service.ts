import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  PriceHistory,
  PriceHistoryCampo,
  PriceHistoryOrigen,
  Variant,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { UpdateVariantPriceDto } from './dto/update-variant-price.dto';
import { VariantSearchQueryDto } from './dto/variant-search-query.dto';
import { PriceHistoryQueryDto } from './dto/price-history-query.dto';
import { CreateVariantGridDto } from './dto/create-variant-grid.dto';
import { PaginatedResult } from './products.service';

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

// RN-11: buscador unificado (nombre de producto, SKU o código de barras
// en un solo campo — un lector de barras es un teclado rápido que
// termina en Enter, el mismo input sirve para los tres casos). RN-3
// sigue aplicando acá: el costo se oculta si quien busca no es OWNER,
// aunque este resultado viaje con datos del producto/talle/color.
export interface VariantSearchResult {
  id: number;
  sku: string;
  barcode: string | null;
  precioVenta: Prisma.Decimal;
  costoActual?: Prisma.Decimal;
  stockActual: number;
  activo: boolean;
  product: { id: number; nombre: string };
  size: { id: number; nombre: string } | null;
  color: { id: number; nombre: string } | null;
}

type VariantSearchRow = Omit<Variant, 'productId' | 'sizeId' | 'colorId'> & {
  product: { id: number; nombre: string };
  size: { id: number; nombre: string } | null;
  color: { id: number; nombre: string } | null;
};

function toSearchResult(
  row: VariantSearchRow,
  isOwner: boolean,
): VariantSearchResult {
  const {
    id,
    sku,
    barcode,
    precioVenta,
    costoActual,
    stockActual,
    activo,
    product,
    size,
    color,
  } = row;

  return {
    id,
    sku,
    barcode,
    precioVenta,
    ...(isOwner && { costoActual }),
    stockActual,
    activo,
    product,
    size,
    color,
  };
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockService: StockService,
  ) {}

  // RN-11/RN-12: buscador unificado, paginado en el servidor. Sin `q`,
  // lista todo lo activo (útil para explorar antes de escribir nada).
  // Solo variantes activas de productos activos (RN-11 — una variante
  // dada de baja, o cuyo producto está dado de baja, no debería
  // resucitar acá aunque la otra mitad siga activa).
  async search(
    query: VariantSearchQueryDto,
    isOwner: boolean,
  ): Promise<PaginatedResult<VariantSearchResult>> {
    const q = query.q?.trim();

    const where: Prisma.VariantWhereInput = {
      activo: true,
      product: { activo: true },
      ...(q && {
        OR: [
          { sku: { contains: q, mode: 'insensitive' } },
          { barcode: { contains: q, mode: 'insensitive' } },
          { product: { nombre: { contains: q, mode: 'insensitive' } } },
        ],
      }),
    };

    const [rows, itemCount] = await Promise.all([
      this.prisma.variant.findMany({
        where,
        include: {
          product: { select: { id: true, nombre: true } },
          size: { select: { id: true, nombre: true } },
          color: { select: { id: true, nombre: true } },
        },
        orderBy: [{ product: { nombre: 'asc' } }, { sku: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.variant.count({ where }),
    ]);

    return {
      items: rows.map((row) => toSearchResult(row, isOwner)),
      itemCount,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

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

  // T2.9 — expone el historial que AD-16/RN-10 ya venían escribiendo
  // (ALTA en create(), MANUAL acá en updatePrice(), INGRESO_MERCADERIA en
  // stock.service.registrarEntrada, MASIVO cuando exista T2.10). Todo el
  // endpoint es OWNER-only a nivel de ruta (RN-3: incluye entradas de
  // COSTO) — no hace falta filtrar filas acá, a diferencia de
  // `hideOwnerOnlyFields`. Más reciente primero: es una vista de
  // auditoría, lo último que cambió es lo que más se busca.
  async getPriceHistory(
    variantId: number,
    query: PriceHistoryQueryDto,
  ): Promise<PaginatedResult<PriceHistory>> {
    const variant = await this.prisma.variant.findUnique({
      where: { id: variantId },
    });
    if (!variant) {
      throw new NotFoundException('Variante no encontrada');
    }

    const [items, itemCount] = await Promise.all([
      this.prisma.priceHistory.findMany({
        where: { variantId },
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.priceHistory.count({ where: { variantId } }),
    ]);

    return { items, itemCount, page: query.page, pageSize: query.pageSize };
  }

  // T2.11 — RN-8/§12.2: alta de N variantes (talle × color) de una sola
  // vez. OWNER-only a nivel de ruta: la fila 350 de la spec del módulo
  // (matriz de permisos) sugiere que SELLER podría usarlo "sin la
  // columna de costo", pero eso es irreconciliable con el modelo de
  // datos — `costoActual` es NOT NULL y no existe ningún mecanismo para
  // fijarlo después de la creación salvo un ingreso de mercadería (que
  // duplicaría el stock). La fila 411 de la misma spec, y el precedente
  // ya en VERDE de `create()` (T2.2/T2.3, también OWNER-only por el
  // mismo motivo: "crear una variante fija su costo inicial"), coinciden
  // en que el endpoint entero requiere OWNER — esa es la lectura que se
  // implementa acá.
  //
  // A diferencia de create() (una variante suelta, sin stock inicial:
  // arranca en 0 y sin movimiento, invariante 1 trivialmente cierto),
  // cada fila de la grilla pasa su stock inicial por
  // `stock.service.registrarEntrada` (RN-8, textual): "nunca se escribe
  // stock_actual directo". costoActual se fija en el INSERT con el
  // mismo valor que después confirma registrarEntrada (no hay otro valor
  // válido posible antes de la primera entrada — la columna es NOT
  // NULL), así que su price_history de origen INGRESO_MERCADERIA queda
  // con valorAnterior == valorNuevo: es records correcto, no un bug —
  // "el costo inicial se estableció vía esta entrada". precioVenta sí
  // tiene su propia fila ALTA con valorAnterior null, igual que create().
  async createGrid(
    productId: number,
    dto: CreateVariantGridDto,
    userId: number,
  ): Promise<Variant[]> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    if (dto.filas.length !== dto.sizeIds.length * dto.colorIds.length) {
      throw new BadRequestException(
        'La cantidad de filas no coincide con sizeIds × colorIds',
      );
    }

    const filas = dto.filas.map((fila) => {
      const precioVenta = new Prisma.Decimal(fila.precioVenta);
      const costo = new Prisma.Decimal(fila.costo);
      this.assertPositive(precioVenta, 'precioVenta');
      this.assertPositive(costo, 'costo');
      return { ...fila, precioVenta, costo };
    });

    const [sizes, colors] = await Promise.all([
      this.prisma.size.findMany({ where: { id: { in: dto.sizeIds } } }),
      this.prisma.color.findMany({ where: { id: { in: dto.colorIds } } }),
    ]);
    const sizeById = new Map(sizes.map((size) => [size.id, size]));
    const colorById = new Map(colors.map((color) => [color.id, color]));

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created: Variant[] = [];

        for (const fila of filas) {
          const sku =
            fila.sku ||
            this.generateSku(
              productId,
              sizeById.get(fila.sizeId),
              colorById.get(fila.colorId),
            );

          const variant = await tx.variant.create({
            data: {
              productId,
              sizeId: fila.sizeId,
              colorId: fila.colorId,
              sku,
              precioVenta: fila.precioVenta,
              costoActual: fila.costo,
            },
          });

          await tx.priceHistory.create({
            data: {
              variantId: variant.id,
              campo: PriceHistoryCampo.PRECIO_VENTA,
              valorAnterior: null,
              valorNuevo: fila.precioVenta,
              origen: PriceHistoryOrigen.ALTA,
              userId,
            },
          });

          await this.stockService.registrarEntrada(tx, {
            variantId: variant.id,
            cantidad: fila.stock,
            costoUnitario: fila.costo,
            userId,
          });

          created.push(
            await tx.variant.findUniqueOrThrow({ where: { id: variant.id } }),
          );
        }

        return created;
      });
    } catch (error) {
      throw this.translateWriteError(error);
    }
  }

  // Patrón simple y determinístico: P{productId}-{TALLE}-{COLOR}. Usa el
  // id del producto (no su nombre) para no colisionar entre productos
  // distintos que comparten talle/color — la unicidad real la sigue
  // garantizando la constraint de `sku` en la base (P2002 → 409, vía
  // translateWriteError). BLUEPRINT §12.2 solo exige "un patrón,
  // editables" sin fijar cuál: este es el default, y el usuario lo puede
  // cambiar en la fila antes de enviar el alta o después con un PATCH.
  private generateSku(
    productId: number,
    size: { nombre: string } | undefined,
    color: { nombre: string } | undefined,
  ): string {
    const slug = (value: string): string =>
      value
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '');

    const parts = [`P${productId}`];
    if (size) parts.push(slug(size.nombre));
    if (color) parts.push(slug(color.nombre));
    return parts.join('-');
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
