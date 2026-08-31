import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { Sale, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { SalesService, PaginatedResult, SaleListItem } from './sales.service';
import { CreateSaleDto } from './dto/create-sale.dto';
import { FindSalesQueryDto } from './dto/find-sales-query.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { withIdempotency } from '../../common/idempotency/idempotency.util';

@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly prisma: PrismaService,
  ) {}

  // RN-1 (spec sección 4.1): "cualquiera autenticado, es el trabajo del
  // vendedor" — sin @Roles(). `esOwner` se resuelve siempre del rol real
  // de la sesión, nunca de algo que mande el cliente (mismo criterio que
  // `cerrarSesion`/`anularVenta` en el resto del sistema). Idempotente
  // (RN-9, §9.7): mismo patrón que `POST /cash-registers/movements/ingreso`
  // (T3.3) — el interceptor exige el header, `withIdempotency` envuelve la
  // transacción completa.
  @UseInterceptors(IdempotencyInterceptor)
  @Post()
  async crear(
    @Body() dto: CreateSaleDto,
    @CurrentUser() user: RequestUser,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<Sale> {
    return withIdempotency(
      () =>
        this.prisma.$transaction((tx) =>
          this.salesService.crearVenta(tx, {
            userId: user.id,
            esOwner: user.rol === UserRole.OWNER,
            idempotencyKey,
            items: dto.items,
            payments: dto.payments,
            discounts: dto.discounts,
            ajusteRedondeo: dto.ajusteRedondeo,
          }),
        ),
      () => this.prisma.sale.findUnique({ where: { idempotencyKey } }),
    );
  }

  // Ticket nuevo (post Release Candidate) — hallazgo real de uso: sin
  // esto, el número de venta que pide `GET /returns/sales/:numero` era
  // efectivamente imposible de recuperar una vez perdida la notificación
  // del cobro (sin ticket impreso, AMB-9 diferida). Sin @Roles(), mismo
  // criterio que `crear()`: "cualquiera autenticado, es el trabajo del
  // vendedor" — es quien procesa devoluciones en el mostrador, sin este
  // permiso dependería siempre de la dueña para encontrar una venta
  // vieja. `SaleListItem` no expone costo/margen (esos campos ni
  // existen a nivel de cabecera de venta).
  @Get()
  async findAll(
    @Query() query: FindSalesQueryDto,
  ): Promise<PaginatedResult<SaleListItem>> {
    return this.salesService.findAll({
      page: query.page,
      pageSize: query.pageSize,
      desde: query.desde,
      hasta: query.hasta,
    });
  }
}
