import { IsDateString, IsIn, IsOptional } from 'class-validator';

// GET /resultados — spec del módulo, sección 4. A diferencia de
// `FindExpensesQueryDto` (`GET /expenses`), acá `desde`/`hasta` son
// OBLIGATORIOS — sin filtro de período no hay "resultado" que calcular.
// Formato validado como fecha ISO (`YYYY-MM-DD`); la interpretación de
// esos límites como medianoche a medianoche EN HORA ARGENTINA (AD-13,
// vía `argentinaDayRangeToUtc`, T0.7/T6.5) es responsabilidad de
// `ResultadosService.consultar`, no de este DTO.
export class ResultadosQueryDto {
  @IsDateString()
  desde!: string;

  @IsDateString()
  hasta!: string;
}

// T6.6 — `GET /resultados/ranking-productos`. Mismos `desde`/`hasta`
// obligatorios que `ResultadosQueryDto` (se extiende en vez de repetir),
// más `orden` opcional: valores permitidos validados con `@IsIn` (un
// valor fuera de esa lista → 400 genérico del `ValidationPipe`, mismo
// criterio de la tabla de errores del ticket). El default ('unidades'
// cuando se omite) es responsabilidad de `ResultadosService.
// rankingProductos`, no de este DTO — mismo criterio ya usado en
// `ResultadosQueryDto` para la interpretación de fechas.
export type OrdenRankingProductos = 'unidades' | 'margen';

export class RankingProductosQueryDto extends ResultadosQueryDto {
  @IsOptional()
  @IsIn(['unidades', 'margen'])
  orden?: OrdenRankingProductos;
}

// T6.6 — `GET /resultados/gastos-por-categoria`. Mismo contrato de
// fechas que `ResultadosQueryDto`, sin parámetros adicionales.
export class GastosPorCategoriaQueryDto extends ResultadosQueryDto {}
