import {
  ArrayNotEmpty,
  IsArray,
  IsDecimal,
  IsInt,
  IsOptional,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// RN-9: filtro por marca, categoría o selección manual. Sin ningún campo
// (`filtro: {}`), el porcentaje se aplica a todo el catálogo activo —
// mismo criterio que `GET /variants/search` sin `q` (RN-11/RN-12): "sin
// filtro, todo lo activo".
export class BulkPriceUpdateFiltroDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  brandId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @Type(() => Number)
  @IsInt({ each: true })
  variantIds?: number[];
}

export class BulkPriceUpdateDto {
  @ValidateNested()
  @Type(() => BulkPriceUpdateFiltroDto)
  filtro: BulkPriceUpdateFiltroDto = new BulkPriceUpdateFiltroDto();

  // String, no number — mismo motivo que precioVenta/costoUnitario en el
  // resto del módulo (BLUEPRINT §9.3): un JSON number ya perdió precisión
  // en JSON.parse antes de llegar acá. Puede ser negativo (rebaja) o
  // positivo (aumento) — el blueprint no restringe el signo, solo dice
  // "aplica un porcentaje" (§5.2); DECISIONES_PENDIENTES.md A5 describe el
  // caso de uso típico ("subir un porcentaje") pero no lo prohíbe.
  @IsDecimal({ decimal_digits: '0,2', force_decimal: false })
  porcentaje!: string;
}
