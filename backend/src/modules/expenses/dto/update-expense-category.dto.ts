import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';

// Mismo patrón que `UpdateBrandDto`/`UpdateCategoryDto` (`products`) —
// el chequeo de `bloqueada` (rechaza CUALQUIER cambio si es `true`) y
// el de nombre-mercadería (AD-7) viven en el servicio, no acá: son
// reglas de negocio, este DTO solo valida la FORMA.
export class UpdateExpenseCategoryDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nombre?: string;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
