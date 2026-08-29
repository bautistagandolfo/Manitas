import {
  IsDateString,
  IsInt,
  IsOptional,
  Max,
  Min,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';

// Fase 08 (QA adversarial, expenses/resultados) — mismo hallazgo que
// motivó el fix de `argentinaDayRangeToUtc` (T0.7): `@IsDateString()`
// solo valida FORMATO ("YYYY-MM-DD..."), nunca que el día exista en ese
// mes/año — "2026-02-30" pasa. Este listado no pasa por
// `argentinaDayRangeToUtc` (a propósito, ver comentario de la clase: sin
// conversión a hora argentina), así que necesita su PROPIO chequeo de
// calendario — reconstruye la fecha desde los primeros 10 caracteres del
// string ("YYYY-MM-DD", la parte que importa acá aunque el string traiga
// hora) y confirma que el año/mes/día declarados sobreviven el
// round-trip por `Date.UTC`; si `Date.UTC` los "rodó" (30 de febrero →
// 2 de marzo), no coinciden y se rechaza.
@ValidatorConstraint({ name: 'isValidCalendarDate', async: false })
class IsValidCalendarDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') {
      return true; // `@IsDateString()` ya rechaza esto — no duplicar el mensaje.
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) {
      return true; // idem — formato inválido, ya lo cubre `@IsDateString()`.
    }
    const [, yearStr, monthStr, dayStr] = match;
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    const reconstruido = new Date(Date.UTC(year, month - 1, day));
    return (
      reconstruido.getUTCFullYear() === year &&
      reconstruido.getUTCMonth() === month - 1 &&
      reconstruido.getUTCDate() === day
    );
  }

  defaultMessage(): string {
    return '$property no es un día de calendario válido';
  }
}

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
