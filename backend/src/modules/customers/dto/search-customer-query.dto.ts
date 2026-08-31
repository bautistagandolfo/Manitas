import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

// Mismo criterio que `ProductQueryDto`: "true"/"false" de un query param
// siempre llega como string, y `Boolean("false")` da `true` en JS.
function parseBooleanQueryParam({ value }: { value: unknown }): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

// Nombre o DNI — mismo criterio que `VariantSearchQueryDto` (un campo
// cubre varios casos de búsqueda). Sin `q`, la lista completa activa
// (pocos clientes al principio, no hace falta paginar todavía).
export class SearchCustomerQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  // Ticket nuevo (post Release Candidate) — la pantalla de Clientes
  // necesita ver también los dados de baja (para poder reactivarlos si se
  // dieron de baja por error); todo lo demás que ya usaba este endpoint
  // (buscador de `DevolucionPage`, autocompletado de crédito en
  // `CobroPage`) sigue viendo solo activos por default — comportamiento
  // sin cambios si no se manda este parámetro.
  @IsOptional()
  @Transform(parseBooleanQueryParam)
  @IsBoolean()
  incluirInactivos?: boolean;
}
