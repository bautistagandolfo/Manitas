import { IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateAjusteDto {
  @IsInt()
  variantId!: number;

  // Positivo o negativo (RN-5) — un ajuste corrige el conteo en cualquier
  // sentido, no solo hacia abajo. 0 es válido aunque sea un no-op: un
  // conteo físico que confirma el stock sin cambios igual queda auditado
  // (motivo obligatorio de todos modos).
  @IsInt()
  delta!: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  motivo!: string;
}
