import { Controller, Get, Query } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  ResultadosService,
  ResultadosResponse,
  RankingProductoItem,
  GastoPorCategoriaItem,
} from './resultados.service';
import {
  ResultadosQueryDto,
  RankingProductosQueryDto,
  GastosPorCategoriaQueryDto,
} from './dto/resultados-query.dto';
import { Roles } from '../../common/auth/roles.decorator';

// T6.4 — wiring de `GET /resultados` (RN-11, BLUEPRINT §5.1 literal:
// "SELLER no accede a... módulo de resultados"). Mismo criterio
// OWNER-only ya usado en `ExpensesController` (T6.2, Fase 06 del
// módulo). Lectura pura: no abre transacción acá — `ResultadosService.
// consultar` abre la suya propia (ver comentario del servicio).
//
// T6.6 agrega `ranking-productos` y `gastos-por-categoria` al mismo
// controller (no uno nuevo) — mismas rutas con nombre fijo, sin
// parámetro dinámico en este controller que pueda colisionar con ellas.
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

  @Roles(UserRole.OWNER)
  @Get('ranking-productos')
  async rankingProductos(
    @Query() query: RankingProductosQueryDto,
  ): Promise<RankingProductoItem[]> {
    return this.resultadosService.rankingProductos({
      desde: query.desde,
      hasta: query.hasta,
      orden: query.orden,
    });
  }

  @Roles(UserRole.OWNER)
  @Get('gastos-por-categoria')
  async gastosPorCategoria(
    @Query() query: GastosPorCategoriaQueryDto,
  ): Promise<GastoPorCategoriaItem[]> {
    return this.resultadosService.gastosPorCategoria({
      desde: query.desde,
      hasta: query.hasta,
    });
  }
}
