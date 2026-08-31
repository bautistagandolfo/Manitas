import { IsOptional, IsString, MaxLength } from 'class-validator';

// Nombre o DNI — mismo criterio que `VariantSearchQueryDto` (un campo
// cubre varios casos de búsqueda). Sin `q`, la lista completa activa
// (pocos clientes al principio, no hace falta paginar todavía).
export class SearchCustomerQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}
