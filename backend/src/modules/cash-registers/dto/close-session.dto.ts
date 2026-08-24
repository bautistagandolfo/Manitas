import { IsDecimal, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CloseSessionDto {
  // String, no number — mismo motivo que en open-session.dto.ts.
  @IsDecimal({ decimal_digits: '0,2', force_decimal: false })
  montoDeclarado!: string;

  // Opcional acá a propósito: si es obligatoria o no depende del rol y de
  // la diferencia (RN-5/RN-6), una regla que el DTO no puede expresar —
  // CashRegisterService.cerrarSesion la valida.
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(1000)
  notaCierre?: string;
}
