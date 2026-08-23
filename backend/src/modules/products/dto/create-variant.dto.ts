import {
  IsDecimal,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

// precioVenta/costoActual viajan como STRING, no como number: un JSON
// number ya pasó por el redondeo de punto flotante de JS.parse antes de
// llegar acá, y BLUEPRINT §9.3 prohíbe cualquier operación de plata que
// no pase por Decimal desde el primer paso — incluida la deserialización
// del body. `@IsDecimal` valida el formato (hasta 2 decimales, como
// DECIMAL(12,2)); el signo (nunca negativo, nunca cero) se valida en el
// servicio, después de parsear con Prisma.Decimal.
const DECIMAL_OPTIONS = { decimal_digits: '0,2', force_decimal: false };

export class CreateVariantDto {
  @IsOptional()
  @IsInt()
  sizeId?: number;

  @IsOptional()
  @IsInt()
  colorId?: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @IsDecimal(DECIMAL_OPTIONS)
  precioVenta!: string;

  // OWNER-only a nivel de ruta (AMB-11, RESUELTA): crear una variante fija
  // su costo inicial, y "todo lo que decide cuánto cuesta algo es del
  // dueño".
  @IsDecimal(DECIMAL_OPTIONS)
  costoActual!: string;
}
