import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Nunca precioVenta ni costoActual acá — esos van por sus propios
// endpoints (PATCH /variants/:id/price, OWNER-only) porque cambiarlos
// exige escribir price_history en la misma transacción (AD-16, RN-10),
// algo que un PATCH de campos sueltos no puede garantizar.
export class UpdateVariantDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sku?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(100)
  barcode?: string;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
