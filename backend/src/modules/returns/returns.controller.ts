import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { Return, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BuscarVentaParaDevolucionResult,
  ReturnsService,
} from './returns.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { withIdempotency } from '../../common/idempotency/idempotency.util';

@Controller('returns')
export class ReturnsController {
  constructor(
    private readonly returnsService: ReturnsService,
    private readonly prisma: PrismaService,
  ) {}

  // Spec sección 4: cualquiera autenticado — sin dato de costo/margen que
  // ocultarle a un `SELLER` salvo `costoUnitario` por línea (RN-10 de
  // `sales`, mismo criterio ya aplicado en otros endpoints). Lectura pura,
  // sin idempotencia ni transacción propia (la abre `ReturnsService`).
  @Get('sales/:numero')
  async buscarVentaPorNumero(
    @Param('numero', ParseIntPipe) numero: number,
    @CurrentUser() user: RequestUser,
  ): Promise<BuscarVentaParaDevolucionResult> {
    return this.returnsService.buscarVentaParaDevolucion(numero, {
      incluirCosto: user.rol === UserRole.OWNER,
    });
  }

  // RN-1 (spec sección 4): "cualquiera autenticado, es el trabajo del
  // vendedor" — sin @Roles(). `esOwner` se resuelve siempre del rol real
  // de la sesión, nunca de algo que mande el cliente (mismo criterio que
  // `SalesController.crear`). Idempotente (RN-9, §9.7): mismo patrón
  // exacto que `POST /sales`.
  @UseInterceptors(IdempotencyInterceptor)
  @Post()
  async crear(
    @Body() dto: CreateReturnDto,
    @CurrentUser() user: RequestUser,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<Return> {
    return withIdempotency(
      () =>
        this.prisma.$transaction((tx) =>
          this.returnsService.crearDevolucion(tx, {
            saleId: dto.saleId,
            tipo: dto.tipo,
            items: dto.items,
            returnPayments: dto.returnPayments,
            ventaNueva: dto.ventaNueva,
            userId: user.id,
            esOwner: user.rol === UserRole.OWNER,
            idempotencyKey,
          }),
        ),
      () => this.prisma.return.findUnique({ where: { idempotencyKey } }),
    );
  }
}
