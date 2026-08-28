import { IsDateString, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

// GET /expenses — spec del módulo, sección 4. Mismo patrón de paginación
// que `VariantSearchQueryDto` (`products`). `desde`/`hasta` son opcionales
// ("sin filtro trae todo") y se validan solo como fecha ISO — la
// conversión a hora argentina (AD-13) es para `resultados`, no para este
// listado crudo.
export class FindExpensesQueryDto {
  @IsOptional()
  @IsDateString()
  desde?: string;

  @IsOptional()
  @IsDateString()
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}
