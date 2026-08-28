import { Body, Controller, Get, Post, Query, UseInterceptors } from '@nestjs/common';
import { Expense, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ExpensesService } from './expenses.service';
import { CreateExpenseDto } from './dto/create-expense.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { withIdempotency } from '../../common/idempotency/idempotency.util';

// T6.2 — STUB de Fase 04a: wiring real (rutas, guards, DTO,
// idempotencia) para que `expenses.integration.spec.ts` pueda pegarle a
// un endpoint real y fallar por la excepción del stub de
// `ExpensesService`, no por un 404 de ruta inexistente. Mismo patrón
// mecánico que `CashRegistersController.ingreso`/`retiro` (T3.3):
// la transacción se abre acá, el servicio nunca abre la suya.
//
// `POST /expenses` y `GET /expenses` son OWNER-only (Fase 06 del
// módulo: un gasto revela montos contra categorías sensibles como
// "Sueldos" — la misma restricción que `resultados`).
@Controller('expenses')
export class ExpensesController {
  constructor(
    private readonly expensesService: ExpensesService,
    private readonly prisma: PrismaService,
  ) {}

  @Roles(UserRole.OWNER)
  @UseInterceptors(IdempotencyInterceptor)
  @Post()
  async create(
    @Body() dto: CreateExpenseDto,
    @CurrentUser() user: RequestUser,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<Expense> {
    return withIdempotency(
      () =>
        this.prisma.$transaction((tx) =>
          this.expensesService.registrarGasto(tx, {
            expenseCategoryId: dto.expenseCategoryId,
            descripcion: dto.descripcion,
            monto: dto.monto,
            medioPago: dto.medioPago,
            userId: user.id,
            idempotencyKey,
          }),
        ),
      () => this.prisma.expense.findUnique({ where: { idempotencyKey } }),
    );
  }

  @Roles(UserRole.OWNER)
  @Get()
  async findAll(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<unknown> {
    return this.expensesService.findAll(
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 20,
    );
  }
}
