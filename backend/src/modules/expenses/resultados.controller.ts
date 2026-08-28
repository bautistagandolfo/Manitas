import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ResultadosService, ResultadosResponse } from './resultados.service';
import { ResultadosQueryDto } from './dto/resultados-query.dto';
import { Roles } from '../../common/auth/roles.decorator';

// T6.4 — wiring de `GET /resultados` (RN-11, BLUEPRINT §5.1 literal:
// "SELLER no accede a... módulo de resultados"). Mismo criterio
// OWNER-only ya usado en `ExpensesController` (T6.2, Fase 06 del
// módulo). Lectura pura: no abre transacción acá — `ResultadosService.
// consultar` abre la suya propia (ver comentario del servicio).
@Controller('resultados')
export class ResultadosController {
  constructor(private readonly resultadosService: ResultadosService) {}

  @Roles(UserRole.OWNER)
  @Get()
  async consultar(
    @Query() query: ResultadosQueryDto,
  ): Promise<ResultadosResponse> {
    return this.resultadosService.consultar({
      desde: query.desde,
      hasta: query.hasta,
    });
  }
}
