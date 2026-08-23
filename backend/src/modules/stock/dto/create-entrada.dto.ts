import { IsDecimal, IsInt, IsPositive } from 'class-validator';

export class CreateEntradaDto {
  @IsInt()
  variantId!: number;

  @IsInt()
  @IsPositive()
  cantidad!: number;

  // String, no number — ver create-variant.dto.ts (products): un JSON
  // number ya pasó por el redondeo de punto flotante de JSON.parse antes
  // de llegar acá, y BLUEPRINT §9.3 exige Decimal desde el primer paso.
  @IsDecimal({ decimal_digits: '0,2', force_decimal: false })
  costoUnitario!: string;
}
