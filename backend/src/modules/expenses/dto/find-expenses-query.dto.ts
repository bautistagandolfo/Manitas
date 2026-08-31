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

// Fase 08 (QA adversarial, expenses/resultados) — mismo hallazgo que
// motivó el fix de `argentinaDayRangeToUtc` (T0.7): `@IsDateString()`
// solo valida FORMATO ("YYYY-MM-DD..."), nunca que el día exista en ese
// mes/año — "2026-02-30" pasa. Este listado no pasa por
// `argentinaDayRangeToUtc` (a propósito, ver comentario de la clase: sin
// conversión a hora argentina), así que necesita su PROPIO chequeo de
// calendario — `IsValidCalendarDateConstraint` (extraída a
// `common/validation/` cuando `sales` agregó un segundo consumidor).
//
// GET /expenses — spec del módulo, sección 4. Mismo patrón de paginación
// que `VariantSearchQueryDto` (`products`). `desde`/`hasta` son opcionales
// ("sin filtro trae todo") y se validan solo como fecha ISO — la
// conversión a hora argentina (AD-13) es para `resultados`, no para este
// listado crudo.
export class FindExpensesQueryDto {
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
