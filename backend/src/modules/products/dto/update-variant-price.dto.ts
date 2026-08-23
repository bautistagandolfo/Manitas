import { IsDecimal } from 'class-validator';

export class UpdateVariantPriceDto {
  // String, no number — ver create-variant.dto.ts.
  @IsDecimal({ decimal_digits: '0,2', force_decimal: false })
  precioVenta!: string;
}
