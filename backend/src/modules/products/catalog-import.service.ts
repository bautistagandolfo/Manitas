import { BadRequestException, Injectable } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { Prisma, PriceHistoryCampo, PriceHistoryOrigen } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from '../stock/stock.service';
import { generateSku } from './sku.util';
import { ImportCatalogDto } from './dto/import-catalog.dto';

// T2.13 / AMB-12 (RESUELTA 2026-08-23): plantilla propia de columnas —
// no depende de la respuesta de B4 (DECISIONES_PENDIENTES.md). Si B4
// revela un formato existente de la clienta, el ajuste queda en el
// mapeo de columnas de acá, no en el resto del ticket.
const REQUIRED_HEADERS = ['nombre', 'precio', 'costo', 'stock'] as const;

export interface ImportRowResult {
  linea: number;
  estado: 'OK' | 'ERROR';
  mensaje?: string;
  sku?: string;
}

export interface ImportResult {
  // "filasCount", no "totalFilas": el linter local no-number-money trata
  // cualquier "total" tipado number como un importe de plata (BLUEPRINT
  // §9.3) — acá es una cantidad de filas, no dinero.
  filasCount: number;
  exitosas: number;
  fallidas: number;
  filas: ImportRowResult[];
}

interface CsvRow {
  nombre?: string;
  descripcion?: string;
  marca?: string;
  categoria?: string;
  talle?: string;
  color?: string;
  sku?: string;
  barcode?: string;
  precio?: string;
  costo?: string;
  stock?: string;
}

interface ImportCaches {
  products: Map<string, number>;
  sizes: Map<string, number>;
  colors: Map<string, number>;
  brands: Map<string, number>;
  categories: Map<string, number>;
}

function createCaches(): ImportCaches {
  return {
    products: new Map(),
    sizes: new Map(),
    colors: new Map(),
    brands: new Map(),
    categories: new Map(),
  };
}

// Cada fila usa su PROPIA copia de la caché durante su transacción — si
// la fila falla, el rollback de la base deja huérfano cualquier
// producto/talle/color que esa fila haya creado, pero las mutaciones de
// un Map de JS no se deshacen solas con el rollback. Sin esta copia, una
// fila fallida podría dejar en la caché compartida el id de una
// creación que en la base nunca quedó — y una fila posterior con el
// mismo nombre reusaría ese id inexistente (P2003 en cascada). Se
// mergea a la caché compartida recién cuando la transacción de la fila
// termina bien.
function cloneCaches(caches: ImportCaches): ImportCaches {
  return {
    products: new Map(caches.products),
    sizes: new Map(caches.sizes),
    colors: new Map(caches.colors),
    brands: new Map(caches.brands),
    categories: new Map(caches.categories),
  };
}

function mergeCaches(target: ImportCaches, source: ImportCaches): void {
  for (const [key, value] of source.products) target.products.set(key, value);
  for (const [key, value] of source.sizes) target.sizes.set(key, value);
  for (const [key, value] of source.colors) target.colors.set(key, value);
  for (const [key, value] of source.brands) target.brands.set(key, value);
  for (const [key, value] of source.categories)
    target.categories.set(key, value);
}

// Valida y parsea un campo de importe: obligatorio, formato Decimal
// válido, > 0, hasta 2 decimales — mismas reglas que el resto del
// módulo (create-variant.dto.ts), pero acá el valor viene de una celda
// de texto libre, no de un DTO con class-validator.
export function parseDecimalField(
  raw: string | undefined,
  campo: string,
): Prisma.Decimal {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new Error(`${campo} es obligatorio`);
  }
  let value: Prisma.Decimal;
  try {
    value = new Prisma.Decimal(trimmed);
  } catch {
    throw new Error(`${campo} "${raw}" no es un número válido`);
  }
  if (value.lessThanOrEqualTo(0)) {
    throw new Error(`${campo} tiene que ser mayor a 0`);
  }
  if (value.decimalPlaces() > 2) {
    throw new Error(`${campo} no puede tener más de 2 decimales`);
  }
  return value;
}

export function parseStockField(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    throw new Error('stock es obligatorio');
  }
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`stock "${raw}" tiene que ser un entero mayor o igual a 0`);
  }
  return value;
}

function translateRowError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      const target = error.meta?.target;
      const targetStr = Array.isArray(target)
        ? target.join(',')
        : typeof target === 'string'
          ? target
          : '';
      if (targetStr.includes('sku'))
        return 'Ya existe una variante con ese SKU';
      if (targetStr.includes('barcode')) {
        return 'Ya existe una variante con ese código de barras';
      }
      return 'Ya existe una variante con esos datos (talle/color duplicado para el producto)';
    }
    if (error.code === 'P2003') {
      return 'Referencia inválida (talle, color, marca o categoría)';
    }
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Error desconocido al procesar la fila';
}

@Injectable()
export class CatalogImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockService: StockService,
  ) {}

  // OWNER-only a nivel de ruta (mismo motivo que create()/createGrid():
  // toda fila fija un costo inicial). Cada fila se procesa en su propia
  // transacción — un error en la fila 47 no debe tirar abajo las 46 que
  // ya se cargaron bien ("validación con reporte de errores línea por
  // línea", DECISIONES_PENDIENTES.md C2). Sin Idempotency-Key: a
  // diferencia de T2.5 (duplicar stock) o T2.10 (recomponer un
  // porcentaje), reenviar el mismo CSV dos veces no duplica nada — la
  // segunda vez cada fila choca con la constraint única de `sku` y se
  // reporta como error, no como una escritura silenciosa duplicada.
  async import(dto: ImportCatalogDto, userId: number): Promise<ImportResult> {
    const rows = this.parseCsv(dto.csv);
    const caches = createCaches();
    const filas: ImportRowResult[] = [];

    for (const [index, row] of rows.entries()) {
      const linea = index + 2; // fila 1 es el encabezado
      const rowCaches = cloneCaches(caches);
      try {
        const sku = await this.prisma.$transaction((tx) =>
          this.processRow(tx, row, userId, rowCaches),
        );
        mergeCaches(caches, rowCaches);
        filas.push({ linea, estado: 'OK', sku });
      } catch (error) {
        filas.push({
          linea,
          estado: 'ERROR',
          mensaje: translateRowError(error),
        });
      }
    }

    const exitosas = filas.filter((f) => f.estado === 'OK').length;
    return {
      filasCount: filas.length,
      exitosas,
      fallidas: filas.length - exitosas,
      filas,
    };
  }

  // Problemas de encabezado/archivo (no de una fila puntual) se rechazan
  // como 400 — a diferencia de un error de una fila individual, que se
  // reporta dentro de ImportResult, esto impide procesar cualquier fila.
  private parseCsv(csv: string): CsvRow[] {
    let rows: CsvRow[];
    try {
      rows = parse(csv, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        bom: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'CSV inválido';
      throw new BadRequestException(`No se pudo leer el CSV: ${message}`);
    }

    if (rows.length === 0) {
      throw new BadRequestException('El CSV no tiene filas de datos');
    }

    const headers = Object.keys(rows[0]);
    const faltantes = REQUIRED_HEADERS.filter((h) => !headers.includes(h));
    if (faltantes.length > 0) {
      throw new BadRequestException(
        `Faltan columnas obligatorias en el encabezado: ${faltantes.join(', ')}`,
      );
    }

    return rows;
  }

  // Todo dentro de la transacción de la fila: resolver/crear producto,
  // talle, color, marca y categoría; crear la variante; dejar el ALTA de
  // precio_venta en price_history (igual que create()/createGrid(), acá
  // tampoco lo cubre stock.service); y el ingreso de stock inicial vía
  // stock.service.registrarEntrada (RN-8: nunca se escribe stock_actual
  // directo, ni siquiera desde una importación).
  private async processRow(
    tx: Prisma.TransactionClient,
    row: CsvRow,
    userId: number,
    caches: ImportCaches,
  ): Promise<string> {
    const nombre = (row.nombre ?? '').trim();
    if (!nombre) {
      throw new Error('nombre es obligatorio');
    }

    const precioVenta = parseDecimalField(row.precio, 'precio');
    const costo = parseDecimalField(row.costo, 'costo');
    const stock = parseStockField(row.stock);

    const productId = await this.resolveProduct(
      tx,
      nombre,
      row.marca,
      row.categoria,
      caches,
    );

    const talle = row.talle?.trim();
    const color = row.color?.trim();
    const sizeId = talle
      ? await this.resolveSize(tx, talle, caches.sizes)
      : undefined;
    const colorId = color
      ? await this.resolveColor(tx, color, caches.colors)
      : undefined;

    const barcode = row.barcode?.trim() || undefined;
    const sku =
      row.sku?.trim() ||
      generateSku(
        productId,
        talle ? { nombre: talle } : undefined,
        color ? { nombre: color } : undefined,
      );

    const variant = await tx.variant.create({
      data: {
        productId,
        sizeId,
        colorId,
        sku,
        barcode,
        precioVenta,
        costoActual: costo,
      },
    });

    await tx.priceHistory.create({
      data: {
        variantId: variant.id,
        campo: PriceHistoryCampo.PRECIO_VENTA,
        valorAnterior: null,
        valorNuevo: precioVenta,
        origen: PriceHistoryOrigen.ALTA,
        userId,
      },
    });

    await this.stockService.registrarEntrada(tx, {
      variantId: variant.id,
      cantidad: stock,
      costoUnitario: costo,
      userId,
    });

    return sku;
  }

  private async resolveProduct(
    tx: Prisma.TransactionClient,
    nombre: string,
    marcaCell: string | undefined,
    categoriaCell: string | undefined,
    caches: ImportCaches,
  ): Promise<number> {
    const key = nombre.toLowerCase();
    const cached = caches.products.get(key);
    if (cached !== undefined) return cached;

    const existing = await tx.product.findFirst({
      where: { nombre: { equals: nombre, mode: 'insensitive' } },
    });
    if (existing) {
      caches.products.set(key, existing.id);
      return existing.id;
    }

    const marca = marcaCell?.trim();
    const categoria = categoriaCell?.trim();
    const brandId = marca
      ? await this.resolveBrand(tx, marca, caches.brands)
      : undefined;
    const categoryId = categoria
      ? await this.resolveCategory(tx, categoria, caches.categories)
      : undefined;

    const created = await tx.product.create({
      data: { nombre, brandId, categoryId },
    });
    caches.products.set(key, created.id);
    return created.id;
  }

  private async resolveBrand(
    tx: Prisma.TransactionClient,
    nombre: string,
    cache: Map<string, number>,
  ): Promise<number> {
    const key = nombre.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const existing = await tx.brand.findFirst({
      where: { nombre: { equals: nombre, mode: 'insensitive' } },
    });
    if (existing) {
      cache.set(key, existing.id);
      return existing.id;
    }

    const created = await tx.brand.create({ data: { nombre } });
    cache.set(key, created.id);
    return created.id;
  }

  private async resolveCategory(
    tx: Prisma.TransactionClient,
    nombre: string,
    cache: Map<string, number>,
  ): Promise<number> {
    const key = nombre.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const existing = await tx.category.findFirst({
      where: { nombre: { equals: nombre, mode: 'insensitive' } },
    });
    if (existing) {
      cache.set(key, existing.id);
      return existing.id;
    }

    const created = await tx.category.create({ data: { nombre } });
    cache.set(key, created.id);
    return created.id;
  }

  private async resolveColor(
    tx: Prisma.TransactionClient,
    nombre: string,
    cache: Map<string, number>,
  ): Promise<number> {
    const key = nombre.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const existing = await tx.color.findFirst({
      where: { nombre: { equals: nombre, mode: 'insensitive' } },
    });
    if (existing) {
      cache.set(key, existing.id);
      return existing.id;
    }

    const created = await tx.color.create({ data: { nombre } });
    cache.set(key, created.id);
    return created.id;
  }

  // A diferencia de marca/categoría/color, `sizes` tiene `orden` NOT
  // NULL (controla S/M/L/XL en las pantallas) — un talle creado desde el
  // importador se agrega al final del orden existente, no colisiona con
  // uno ya usado.
  private async resolveSize(
    tx: Prisma.TransactionClient,
    nombre: string,
    cache: Map<string, number>,
  ): Promise<number> {
    const key = nombre.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const existing = await tx.size.findFirst({
      where: { nombre: { equals: nombre, mode: 'insensitive' } },
    });
    if (existing) {
      cache.set(key, existing.id);
      return existing.id;
    }

    const max = await tx.size.aggregate({ _max: { orden: true } });
    const created = await tx.size.create({
      data: { nombre, orden: (max._max.orden ?? 0) + 1 },
    });
    cache.set(key, created.id);
    return created.id;
  }
}
