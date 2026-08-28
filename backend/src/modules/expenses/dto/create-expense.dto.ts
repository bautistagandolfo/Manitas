import {
  IsDecimal,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ExpenseMedioPago } from '@prisma/client';

// T6.2 — registro de gasto. `monto` viaja como STRING, no number
// (BLUEPRINT §9.3): `@IsDecimal` valida el FORMATO (máximo 2 decimales),
// mismo estilo que `ManualMovementDto` (cash-registers) — la
// positividad se valida en `ExpensesService.registrarGasto`, no acá.
// `medioPago` es un único valor del enum (no una lista, a diferencia de
// `sales`).
export class CreateExpenseDto {
  @IsInt()
  @IsPositive()
  expenseCategoryId!: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  descripcion!: string;

  @IsDecimal({ decimal_digits: '0,2', force_decimal: false })
  monto!: string;

  @IsEnum(ExpenseMedioPago)
  medioPago!: ExpenseMedioPago;
}
