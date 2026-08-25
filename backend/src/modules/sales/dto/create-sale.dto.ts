import {
  ArrayMaxSize,
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
// Fase 10 (security remediation) — hallazgo LOW de la fase 09 (sección 6
// del reporte de auditoría): sin cota superior, un body con decenas de
// miles de líneas pasaba la validación de forma (cada entrada individual
// es válida) y llegaba íntegro a `crearVenta`, que arma un
// `Prisma.join(variantIds)` y un `tx.sale.create` nested de esa misma
// longitud — consumo de memoria/tiempo de un único request y una
// transacción más larga, sin ninguna ganancia de negocio real (una venta
// de mostrador no tiene cientos de líneas). 500 como techo generoso: muy
// por encima de cualquier venta real, sin inventar un límite de negocio
// más ajustado que el blueprint no pide (mismo criterio que
// `create-variant-grid.dto.ts`, `@ArrayMaxSize(1000)` para su grilla).
// `payments`/`discounts` casi siempre son de un dígito — 20 es igual de
// generoso para el caso real de pagos partidos en varios medios.
export class CreateSaleDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => SaleItemDto)
  items!: SaleItemDto[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SalePaymentDto)
  payments!: SalePaymentDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SaleDiscountDto)
  discounts?: SaleDiscountDto[];

  @IsOptional()
  @IsDecimal(DECIMAL_OPTIONS)
  ajusteRedondeo?: string;
}
