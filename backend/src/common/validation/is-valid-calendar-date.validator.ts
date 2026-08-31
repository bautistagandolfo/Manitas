import {
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

// Extraído de `expenses/dto/find-expenses-query.dto.ts` (Fase 08 de
// `expenses`/`resultados`) al agregar un segundo consumidor
// (`sales/dto/find-sales-query.dto.ts`) — evita la misma duplicación que
// la Fase 07 de ese módulo ya había encontrado y corregido una vez, acá
// para no volver a introducirla.
//
// Hallazgo original: `@IsDateString()` (class-validator) solo valida
// FORMATO ("YYYY-MM-DD..."), nunca que el día exista en ese mes/año —
// "2026-02-30" pasa. Cualquier listado "crudo" que filtra por
// `desde`/`hasta` sin pasar por `argentinaDayRangeToUtc` (que sí valida
// esto para `resultados`, T0.7) necesita este chequeo aparte.
//
// Reconstruye la fecha desde los primeros 10 caracteres del string
// ("YYYY-MM-DD", la parte que importa acá aunque el string traiga hora)
// y confirma que el año/mes/día declarados sobreviven el round-trip por
// `Date.UTC`; si `Date.UTC` los "rodó" (30 de febrero → 2 de marzo), no
// coinciden y se rechaza.
@ValidatorConstraint({ name: 'isValidCalendarDate', async: false })
export class IsValidCalendarDateConstraint implements ValidatorConstraintInterface {
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
