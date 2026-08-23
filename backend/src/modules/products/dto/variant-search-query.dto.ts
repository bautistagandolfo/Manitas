import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class VariantSearchQueryDto {
  // Nombre de producto, SKU o código de barras — un lector de código de
  // barras es un teclado rápido que escribe y manda Enter, así que el
  // mismo campo cubre los tres casos (RN-11). Sin `q`, devuelve todo lo
  // activo paginado (útil para listar antes de escribir nada).
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
