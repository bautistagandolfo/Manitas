import { IsDateString } from 'class-validator';

// GET /resultados — spec del módulo, sección 4. A diferencia de
// `FindExpensesQueryDto` (`GET /expenses`), acá `desde`/`hasta` son
// OBLIGATORIOS — sin filtro de período no hay "resultado" que calcular.
// Formato validado como fecha ISO (`YYYY-MM-DD`); la interpretación de
// esos límites como UTC ingenuo (00:00:00.000Z a 23:59:59.999Z, sin
// ajuste de hora argentina — eso es AD-13/T0.7, T6.5) es responsabilidad
// de `ResultadosService.consultar`, no de este DTO.
export class ResultadosQueryDto {
  @IsDateString()
  desde!: string;

  @IsDateString()
  hasta!: string;
}
