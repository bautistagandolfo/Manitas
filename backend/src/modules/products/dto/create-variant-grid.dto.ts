import {
  ArrayNotEmpty,
  IsArray,
  IsDecimal,
  IsInt,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

// Igual que create-variant.dto.ts: precioVenta/costo viajan como STRING
// (BLUEPRINT §9.3), nunca number.
const DECIMAL_OPTIONS = { decimal_digits: '0,2', force_decimal: false };

// RN-8/§12.2: una fila por combinación talle×color ya resuelta — el
// frontend genera la grilla, la completa (con la opción de aplicar el
// mismo precio/costo a todas) y manda el resultado final acá. `sku`
// opcional: si no viene, el backend genera uno (ver
// VariantsService.generateSku).
export class GridFilaDto {
  @IsInt()
  sizeId!: number;

  @IsInt()
  colorId!: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  sku?: string;

  @IsInt()
  @Min(0)
  stock!: number;

  @IsDecimal(DECIMAL_OPTIONS)
  precioVenta!: string;

  @IsDecimal(DECIMAL_OPTIONS)
  costo!: string;
}

export class CreateVariantGridDto {
  @IsArray()
  @ArrayNotEmpty()
  @Type(() => Number)
  @IsInt({ each: true })
  sizeIds!: number[];

  @IsArray()
  @ArrayNotEmpty()
  @Type(() => Number)
  @IsInt({ each: true })
  colorIds!: number[];

  // Aceptados por fidelidad al contrato (spec del módulo §4.1) — son
  // conveniencia de UI para prellenar la grilla antes de enviarla
  // (BLUEPRINT §12.2, punto 4: "aplicar el mismo precio y costo a todas
  // de una vez"). El backend nunca los usa: cada fila de `filas` ya trae
  // sus valores finales resueltos.
  @IsOptional()
  @IsInt()
  @Min(0)
  stockPorDefecto?: number;

  @IsOptional()
  @IsDecimal(DECIMAL_OPTIONS)
  precioPorDefecto?: string;

  @IsOptional()
  @IsDecimal(DECIMAL_OPTIONS)
  costoPorDefecto?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => GridFilaDto)
  filas!: GridFilaDto[];
}
