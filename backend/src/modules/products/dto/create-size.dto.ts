import { IsInt, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CreateSizeDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nombre!: string;

  // Orden de listado (S, M, L, XL en ese orden, no alfabético) — BLUEPRINT
  // §3.2. Sin esto, el único talle/color sin un lugar lógico para
  // ordenarlos serían marcas/categorías, que sí alcanza con alfabético.
  @IsInt()
  orden!: number;
}
