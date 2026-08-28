import { Injectable } from '@nestjs/common';
import { Expense, ExpenseMedioPago, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

// STUB — Fase 04a (T6.2). Este archivo existe únicamente para que
// `expenses.service.spec.ts` y `expenses.integration.spec.ts` compilen y
// corran en rojo por una aserción real, no por un error de importación.
// Firma tomada del ticket T6.2 (`ROADMAP.md`) y del modelo `Expense` de
// `schema.prisma`.
//
// PROHIBIDO agregarle lógica en esta fase (04a-tests-first.md): ni
// siquiera la validación más obvia. La implementación real es la Fase 04
// del ticket T6.2, en otra sesión.

export interface RegistrarGastoInput {
  expenseCategoryId: number;
  descripcion: string;
  monto: Prisma.Decimal.Value;
  medioPago: ExpenseMedioPago;
  userId: number;
  idempotencyKey: string;
}

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  registrarGasto(
    _tx: Prisma.TransactionClient,
    _input: RegistrarGastoInput,
  ): Promise<Expense> {
    return Promise.reject(new Error('T6.2 todavía no implementado'));
  }

  findAll(_page: number, _pageSize: number): Promise<unknown> {
    return Promise.reject(new Error('T6.2 todavía no implementado'));
  }
}
