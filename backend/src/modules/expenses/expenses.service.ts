import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementReferenciaTipo,
  CashMovementTipo,
  Expense,
  ExpenseMedioPago,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertPositive } from '../../common/money/money.util';
import { CashRegisterService } from '../cash-registers/cash-register.service';

export interface RegistrarGastoInput {
  expenseCategoryId: number;
  descripcion: string;
  monto: Prisma.Decimal.Value;
  medioPago: ExpenseMedioPago;
  userId: number;
  idempotencyKey: string;
}

export interface FindAllExpensesInput {
  page: number;
  pageSize: number;
  desde?: Date;
  hasta?: Date;
}

// "itemCount", no "total" — el linter local `no-number-money` trata
// cualquier `total` tipado number como un importe de plata (BLUEPRINT
// §9.3); acá es una cantidad de filas, mismo criterio que
// `products.service.ts`.
export interface PaginatedResult<T> {
  items: T[];
  itemCount: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class ExpensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cashRegisterService: CashRegisterService,
  ) {}

  // T6.2 (RN-2 a RN-4, RN-7) + T6.3 (invariantes 7 y 10) — registrar un
  // gasto. Recibe siempre el `tx` de una transacción ya abierta por el
  // controller (mismo contrato que
  // `CashRegisterService.registrarMovimiento`/`SalesService.crearVenta`).
  //
  // Orden textual de la spec del módulo, sección 5: validar monto →
  // validar categoría → (solo EFECTIVO) sesión de caja abierta,
  // fail-fast → crear el gasto → (solo EFECTIVO) movimiento de caja
  // vinculado. `TRANSFERENCIA`/`OTRO` no tocan ninguno de los dos pasos
  // de caja — ni siquiera para ver si existe una sesión (invariante 10,
  // literal: "la dueña puede pagar el alquiler un domingo desde su
  // casa") — mismo precedente que `returns` dividió T5.1 ("devolución
  // simple") de T5.3 ("reintegro en efectivo → movimiento de caja").
  async registrarGasto(
    tx: Prisma.TransactionClient,
    input: RegistrarGastoInput,
  ): Promise<Expense> {
    // RN-3: mismo chequeo de positividad que el resto del sistema
    // (`assertPositive`, ya usado en `sales`/`cash-registers`/`products`).
    // La precisión (≤ 2 decimales) también se valida acá, no solo en el
    // DTO (`@IsDecimal`) — este método se llama también desde los tests
    // unitarios sin pasar por el `ValidationPipe` del controller, y
    // Postgres tiene la columna como `Decimal(12, 2)`: sin este chequeo,
    // un valor con más decimales se trunca silenciosamente al insertar.
    const monto = new Prisma.Decimal(input.monto);
    assertPositive(monto, 'El monto');
    if (monto.decimalPlaces() > 2) {
      throw new BadRequestException(
        'El monto no puede tener más de 2 decimales',
      );
    }

    // Spec del módulo, sección 5, paso 1: leer la categoría antes que
    // nada — 404 si no existe, 400 si está desactivada (mismo criterio
    // que una variante `activo: false` en `sales`, T4.1).
    const categoria = await tx.expenseCategory.findUnique({
      where: { id: input.expenseCategoryId },
    });
    if (!categoria) {
      throw new NotFoundException('Categoría de gasto no encontrada');
    }
    if (!categoria.activo) {
      throw new BadRequestException('Esta categoría de gasto está desactivada');
    }

    // T6.3, invariante 10: solo EFECTIVO exige sesión de caja abierta —
    // fail-fast, ANTES de crear el gasto. `getSesionAbiertaOrThrow` ya
    // tira `ConflictException` (409, "No hay una sesión de caja
    // abierta") si no hay ninguna; se llama UNA sola vez (no una segunda
    // vez más abajo para el movimiento) — se reutiliza `sesion.id` ahí,
    // porque `registrarMovimiento` ya bloquea la fila de sesión
    // internamente antes de escribir el movimiento, así que un segundo
    // `SELECT ... FOR UPDATE` sobre la misma fila (misma transacción,
    // misma conexión) sería redundante.
    const sesion =
      input.medioPago === ExpenseMedioPago.EFECTIVO
        ? await this.cashRegisterService.getSesionAbiertaOrThrow(tx)
        : null;

    // `fecha` la completa el servicio, nunca el cliente (spec, tabla de
    // contratos de API). `idempotencyKey` viaja intacta: la detección de
    // una clave repetida (P2002 → devolver la fila existente en vez de
    // duplicar) es responsabilidad de quien abre la transacción
    // (`withIdempotency` en el controller), no de este método — mismo
    // patrón que `CashRegisterService.registrarMovimiento`.
    const gasto = await tx.expense.create({
      data: {
        fecha: new Date(),
        idempotencyKey: input.idempotencyKey,
        expenseCategoryId: input.expenseCategoryId,
        descripcion: input.descripcion,
        monto,
        medioPago: input.medioPago,
        userId: input.userId,
      },
    });

    // T6.3, invariante 7 (los movimientos de tipo GASTO tienen su
    // propio origen): un gasto en efectivo genera un `cash_movement`
    // vinculado. El signo negativo lo aplica `registrarMovimiento`
    // internamente según `tipo` — acá siempre se manda el monto
    // positivo, mismo contrato que `sales`/`returns`. Si el `tx` aborta
    // más adelante (no debería, es el último paso), el gasto tampoco
    // queda persistido: todo corre dentro de la misma transacción que
    // abrió el controller.
    if (sesion) {
      await this.cashRegisterService.registrarMovimiento(tx, {
        sessionId: sesion.id,
        tipo: CashMovementTipo.GASTO,
        monto,
        referenciaTipo: CashMovementReferenciaTipo.EXPENSE,
        referenciaId: gasto.id,
        descripcion: input.descripcion,
        userId: input.userId,
      });
    }

    return gasto;
  }

  // Lectura pura, sin `tx` — mismo criterio que `reconciliar()` de otros
  // módulos. Paginado en el servidor (BLUEPRINT §12.4), ordenado por
  // `fecha` descendente ("lo último siempre arriba", §12.4) — mismo
  // patrón que `VariantsService.search`. `desde`/`hasta` filtran sobre
  // `fecha` tal cual llegan (sin conversión a hora argentina — esa
  // conversión, AD-13/T0.7, es para el cálculo de períodos de
  // `resultados`, no para este listado crudo).
  async findAll(
    input: FindAllExpensesInput,
  ): Promise<PaginatedResult<Expense>> {
    const where: Prisma.ExpenseWhereInput = {
      ...((input.desde || input.hasta) && {
        fecha: {
          ...(input.desde && { gte: input.desde }),
          ...(input.hasta && { lte: input.hasta }),
        },
      }),
    };

    const [items, itemCount] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        orderBy: { fecha: 'desc' },
        skip: (input.page - 1) * input.pageSize,
        take: input.pageSize,
      }),
      this.prisma.expense.count({ where }),
    ]);

    return { items, itemCount, page: input.page, pageSize: input.pageSize };
  }
}
