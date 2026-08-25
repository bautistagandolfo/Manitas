import {
  ArrayNotEmpty,
  IsArray,
  IsDecimal,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { PaymentMetodo } from '@prisma/client';

// String, no number, en todos los importes (BLUEPRINT §9.3) — mismo
// criterio que el resto del proyecto.
const DECIMAL_OPTIONS = { decimal_digits: '0,2', force_decimal: false };

export class SaleItemDto {
  @IsInt()
  variantId!: number;

  @IsInt()
  @Min(1)
  cantidad!: number;
}

// Mutuamente excluyentes (porcentaje o monto) — la resolución real
// (calcular `monto` a partir de `porcentaje` cuando viene, ignorando
// cualquier `monto` mandado junto) la hace `SalesService.crearVenta`
// (T4.3), no este DTO.
export class SaleDiscountDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  descripcion!: string;

  @IsOptional()
  @IsDecimal(DECIMAL_OPTIONS)
  porcentaje?: string;

  @IsOptional()
  @IsDecimal(DECIMAL_OPTIONS)
  monto?: string;
}

export class SalePaymentDto {
  @IsEnum(PaymentMetodo)
  metodo!: PaymentMetodo;

  @IsDecimal(DECIMAL_OPTIONS)
  monto!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(500)
  referencia?: string;
}

// RN-1 (spec sección 4.1): `esOwner` deliberadamente NO es un campo de
// este DTO — se resuelve siempre del rol real del usuario autenticado en
// el controller (`user.rol === 'OWNER'`), nunca de algo que mande el
// cliente. Si el cliente igual lo manda, `forbidNonWhitelisted` (pipe
// global) lo rechaza con 400 antes de llegar al handler.
export class CreateSaleDto {
  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items!: SaleItemDto[];

  @IsArray()
  @ArrayNotEmpty()
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SaleDiscountDto)
  discounts?: SaleDiscountDto[];

  @IsOptional()
  @IsDecimal(DECIMAL_OPTIONS)
  ajusteRedondeo?: string;
}
