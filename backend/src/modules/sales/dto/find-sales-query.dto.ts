import {
  IsDateString,
  IsInt,
  IsOptional,
  Max,
  Min,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IsValidCalendarDateConstraint } from '../../../common/validation/is-valid-calendar-date.validator';

// Ticket nuevo (post Release Candidate) — hallazgo real de uso: el
// número de venta (necesario para `GET /returns/sales/:numero`) hoy
// solo aparece un instante en una notificación al confirmar el cobro —
// sin ticket impreso (AMB-9, diferida) y sin forma de volver a
// encontrarlo, una devolución de una venta de hace unos días es
// efectivamente imposible de procesar. `GET /sales` cierra ese hueco —
// mismo patrón que `FindExpensesQueryDto` (paginación + rango de fecha,
// mismo validador de calendario compartido): `desde`/`hasta` son
// opcionales ("sin filtro trae todo", ordenado por más reciente
// primero). Acá el DTO solo valida FORMATO (fecha ISO) — la conversión a
// hora argentina (AD-13/T0.7) pasa en `SalesService.findAll`, vía
// `argentinaDayRangeToUtc`. A diferencia de `GET /expenses` (que quedó
// con un `Date.UTC` ingenuo sin corregir, fuera de alcance de este
// ticket): un rango "hasta hoy" sin esa conversión excluiría casi todo
// el día de hoy en hora argentina.
export class FindSalesQueryDto {
  @IsOptional()
  @IsDateString()
  @Validate(IsValidCalendarDateConstraint)
  desde?: string;

  @IsOptional()
  @IsDateString()
  @Validate(IsValidCalendarDateConstraint)
  hasta?: string;

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
