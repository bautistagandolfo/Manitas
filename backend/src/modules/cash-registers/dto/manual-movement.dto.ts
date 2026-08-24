import { IsDecimal, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class ManualMovementDto {
  // String, no number — mismo motivo que montoInicial en
  // open-session.dto.ts (BLUEPRINT §9.3). Positividad validada en
  // CashRegisterService.registrarMovimiento (RN-3), no acá.
  @IsDecimal({ decimal_digits: '0,2', force_decimal: false })
  monto!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  descripcion!: string;
}
