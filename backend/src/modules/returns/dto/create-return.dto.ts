import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
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
import { PaymentMetodo, ReturnTipo } from '@prisma/client';

// String, no number, en todos los importes (BLUEPRINT §9.3) — mismo
// criterio que `create-sale.dto.ts`.
const DECIMAL_OPTIONS = { decimal_digits: '0,2', force_decimal: false };

export class ReturnItemDto {
  @IsInt()
  saleItemId!: number;

  @IsInt()
  @Min(1)
  cantidad!: number;

  @IsBoolean()
  reingresaStock!: boolean;
}

export class ReturnPaymentDto {
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

// T5.5 (RN-9) — la venta nueva de un `CAMBIO`: mismos ítems/descuentos que
// `CreateSaleDto`, pero `payments` acá son SOLO los pagos ADEMÁS del
// crédito (que se manda como una línea más de `returnPayments`, con
// `metodo: CREDITO_DEVOLUCION` — ver `ReturnsService.crearDevolucion`,
// paso 14). Reusa los mismos sub-DTOs de forma, no importa `sales/dto`
// para no crear un acoplamiento de módulos innecesario por dos clases
// triviales.
export class ReturnVentaNuevaItemDto {
  @IsInt()
  variantId!: number;

  @IsInt()
  @Min(1)
  cantidad!: number;
}

export class ReturnVentaNuevaDiscountDto {
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

export class ReturnVentaNuevaDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReturnVentaNuevaItemDto)
  items!: ReturnVentaNuevaItemDto[];

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReturnPaymentDto)
  payments!: ReturnPaymentDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReturnVentaNuevaDiscountDto)
  discounts?: ReturnVentaNuevaDiscountDto[];

  @IsOptional()
  @IsDecimal(DECIMAL_OPTIONS)
  ajusteRedondeo?: string;
}

// RN-1 (spec sección 4): `esOwner` deliberadamente NO es un campo de este
// DTO — se resuelve siempre del rol real del usuario autenticado en el
// controller, nunca de algo que mande el cliente (mismo criterio que
// `CreateSaleDto`). `forbidNonWhitelisted` (pipe global) rechaza con 400
// si el cliente igual lo manda.
export class CreateReturnDto {
  @IsInt()
  saleId!: number;

  @IsEnum(ReturnTipo)
  tipo!: ReturnTipo;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReturnItemDto)
  items!: ReturnItemDto[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReturnPaymentDto)
  returnPayments!: ReturnPaymentDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ReturnVentaNuevaDto)
  ventaNueva?: ReturnVentaNuevaDto;
}
