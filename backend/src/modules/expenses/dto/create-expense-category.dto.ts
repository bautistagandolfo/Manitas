import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

// Mismo patrón que `CreateBrandDto`/`CreateCategoryDto` (`products`) —
// sin `activo`/`bloqueada`: una categoría nueva nace siempre activa y
// nunca bloqueada (RN-1 de `modulo-expenses-resultados-spec.md`, solo
// las 6 seedeadas de `seed.ts` nacen `bloqueada: true`).
export class CreateExpenseCategoryDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nombre!: string;
}
