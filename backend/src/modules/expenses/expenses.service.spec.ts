import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseMedioPago, Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ExpensesService } from './expenses.service';

// Fase 04a (T6.2) — tests escritos ANTES de la implementación, contra
// Prisma completamente mockeado. Fuente única: el ticket T6.2 pasado en
// el prompt de esta fase (derivado de `ROADMAP.md`, BLUEPRINT §9.3/§9.4/
// §9.7 e invariante 10, y la tabla de errores de la spec del módulo,
// sección 7). NO se leyó ninguna implementación de `expenses` — solo la
// ESTRUCTURA de `cash-register.service.spec.ts` (patrón MockTx) y el
// código YA CERRADO de T6.1 (`expense-categories.service.ts`) como
// convención mecánica del repo, nunca como fuente de la lógica de T6.2.
//
// Diseño del mock de `tx`: mismo criterio que `cash-register.service.spec.ts`
// — `MockTx` es un tipo propio sin intersecar `Prisma.TransactionClient`.
// La firma exacta de `registrarGasto` (qué recibe como `tx` + qué shape de
// input) sigue el patrón mecánico de `CashRegisterService.registrarMovimiento`
// (`tx` como primer parámetro, la transacción se abre en el controller).
//
// Nota de alcance sobre "idempotencia" en este archivo: en el patrón ya
// establecido del repo (`CashRegisterService.registrarMovimiento`, ver su
// comentario "la detección de la clave duplicada... la maneja quien llama
// (withIdempotency) envolviendo esta llamada"), el SERVICIO nunca atrapa el
// P2002 de `idempotency_key` — eso es responsabilidad exclusiva de quien
// abre la transacción (el controller, con `withIdempotency`), porque un
// catch dentro del mismo `tx` no puede volver a consultarlo una vez que
// Postgres lo abortó. Achá se prueba la mitad que sí es responsabilidad del
// servicio: que `idempotencyKey` viaja intacto hasta el `create`. El
// comportamiento de "un reintento no duplica" completo (P2002 → devolver
// la fila existente) se prueba de punta a punta contra Postgres real en
// `expenses.integration.spec.ts`.

interface ExpenseCategoryRow {
  id: number;
  nombre: string;
  activo: boolean;
  bloqueada: boolean;
}

interface ExpenseRow {
  id: number;
  fecha: Date;
  idempotencyKey: string | null;
  expenseCategoryId: number;
  descripcion: string;
  monto: Prisma.Decimal;
  medioPago: ExpenseMedioPago;
  userId: number;
}

interface ExpenseCreateCall {
  data: {
    fecha: Date;
    idempotencyKey: string;
    expenseCategoryId: number;
    descripcion: string;
    monto: Prisma.Decimal.Value;
    medioPago: ExpenseMedioPago;
    userId: number;
  };
}

interface MockTx {
  expenseCategory: {
    findUnique: jest.Mock<Promise<ExpenseCategoryRow | null>, [unknown]>;
  };
  expense: {
    create: jest.Mock<Promise<ExpenseRow>, [ExpenseCreateCall]>;
  };
}

function buildCategoria(
  overrides: Partial<ExpenseCategoryRow> = {},
): ExpenseCategoryRow {
  return {
    id: 3,
    nombre: 'Servicios',
    activo: true,
    bloqueada: false,
    ...overrides,
  };
}

function buildMockTx(categoria: ExpenseCategoryRow | null): MockTx {
  return {
    expenseCategory: {
      findUnique: jest
        .fn<Promise<ExpenseCategoryRow | null>, [unknown]>()
        .mockResolvedValue(categoria),
    },
    expense: {
      create: jest
        .fn<Promise<ExpenseRow>, [ExpenseCreateCall]>()
        .mockImplementation((args) =>
          Promise.resolve({
            id: 900,
            fecha: args.data.fecha,
            idempotencyKey: args.data.idempotencyKey,
            expenseCategoryId: args.data.expenseCategoryId,
            descripcion: args.data.descripcion,
            monto: new Prisma.Decimal(args.data.monto),
            medioPago: args.data.medioPago,
            userId: args.data.userId,
          }),
        ),
    },
  };
}

describe('ExpensesService.registrarGasto (T6.2)', () => {
  let service: ExpensesService;

  beforeEach(() => {
    service = new ExpensesService({} as unknown as PrismaService);
  });

  describe.each([
    ExpenseMedioPago.EFECTIVO,
    ExpenseMedioPago.TRANSFERENCIA,
    ExpenseMedioPago.OTRO,
  ])('camino feliz — medioPago %s', (medioPago) => {
    it('crea el gasto con la categoría activa, y sin chequear sesión de caja (fuera de alcance de T6.2, ver invariante 10)', async () => {
      const tx = buildMockTx(buildCategoria());

      const result = await service.registrarGasto(
        tx as unknown as Prisma.TransactionClient,
        {
          expenseCategoryId: 3,
          descripcion: 'Pago de luz',
          monto: '1500.50',
          medioPago,
          userId: 42,
          idempotencyKey: 'idem-key-1',
        },
      );

      expect(tx.expenseCategory.findUnique).toHaveBeenCalledWith({
        where: { id: 3 },
      });
      expect(tx.expense.create).toHaveBeenCalledTimes(1);
      const call = tx.expense.create.mock.calls[0][0];
      expect(call.data.expenseCategoryId).toBe(3);
      expect(call.data.descripcion).toBe('Pago de luz');
      expect(new Prisma.Decimal(call.data.monto).toString()).toBe('1500.5');
      expect(call.data.medioPago).toBe(medioPago);
      expect(call.data.userId).toBe(42);
      expect(call.data.idempotencyKey).toBe('idem-key-1');
      // `fecha` la completa el servicio solo, nunca la manda el cliente.
      expect(call.data.fecha).toBeInstanceOf(Date);

      expect(result).toEqual(
        expect.objectContaining({
          id: 900,
          expenseCategoryId: 3,
          medioPago,
          userId: 42,
        }),
      );
    });
  });

  it('categoría inexistente → 404 "Categoría de gasto no encontrada", sin crear el gasto', async () => {
    const tx = buildMockTx(null);

    const call = service.registrarGasto(
      tx as unknown as Prisma.TransactionClient,
      {
        expenseCategoryId: 999,
        descripcion: 'Gasto x',
        monto: '100.00',
        medioPago: ExpenseMedioPago.EFECTIVO,
        userId: 1,
        idempotencyKey: 'idem-key-2',
      },
    );
    await expect(call).rejects.toBeInstanceOf(NotFoundException);
    await expect(call).rejects.toThrow('Categoría de gasto no encontrada');
    expect(tx.expense.create).not.toHaveBeenCalled();
  });

  it('categoría inactiva → 400 "Esta categoría de gasto está desactivada", sin crear el gasto', async () => {
    const tx = buildMockTx(buildCategoria({ activo: false }));

    const call = service.registrarGasto(
      tx as unknown as Prisma.TransactionClient,
      {
        expenseCategoryId: 3,
        descripcion: 'Gasto x',
        monto: '100.00',
        medioPago: ExpenseMedioPago.EFECTIVO,
        userId: 1,
        idempotencyKey: 'idem-key-3',
      },
    );
    await expect(call).rejects.toBeInstanceOf(BadRequestException);
    await expect(call).rejects.toThrow(
      'Esta categoría de gasto está desactivada',
    );
    expect(tx.expense.create).not.toHaveBeenCalled();
  });

  it.each(['0', '-1', '-100.50'])(
    'monto "%s" (≤ 0) → 400, sin crear el gasto',
    async (monto) => {
      const tx = buildMockTx(buildCategoria());

      await expect(
        service.registrarGasto(tx as unknown as Prisma.TransactionClient, {
          expenseCategoryId: 3,
          descripcion: 'Gasto x',
          monto,
          medioPago: ExpenseMedioPago.EFECTIVO,
          userId: 1,
          idempotencyKey: 'idem-key-4',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.expense.create).not.toHaveBeenCalled();
    },
  );

  it.each(['10.123', '99.999', '1.005'])(
    'monto "%s" (más de 2 decimales) → 400, sin crear el gasto',
    async (monto) => {
      const tx = buildMockTx(buildCategoria());

      await expect(
        service.registrarGasto(tx as unknown as Prisma.TransactionClient, {
          expenseCategoryId: 3,
          descripcion: 'Gasto x',
          monto,
          medioPago: ExpenseMedioPago.EFECTIVO,
          userId: 1,
          idempotencyKey: 'idem-key-5',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.expense.create).not.toHaveBeenCalled();
    },
  );

  it('idempotencyKey viaja intacto hasta el create (la mitad de §9.7 que es responsabilidad del servicio — la otra mitad, "un reintento no duplica", es del controller/withIdempotency, ver nota de archivo)', async () => {
    const tx = buildMockTx(buildCategoria());

    await service.registrarGasto(
      tx as unknown as Prisma.TransactionClient,
      {
        expenseCategoryId: 3,
        descripcion: 'Gasto x',
        monto: '100.00',
        medioPago: ExpenseMedioPago.EFECTIVO,
        userId: 1,
        idempotencyKey: 'idem-key-repetida',
      },
    );

    expect(tx.expense.create.mock.calls[0][0].data.idempotencyKey).toBe(
      'idem-key-repetida',
    );
  });

  it('userId viene del parámetro (contexto de auth), nunca de un campo dentro del body/input que lo pudiera pisar', async () => {
    const tx = buildMockTx(buildCategoria());

    await service.registrarGasto(tx as unknown as Prisma.TransactionClient, {
      expenseCategoryId: 3,
      descripcion: 'Gasto x',
      monto: '100.00',
      medioPago: ExpenseMedioPago.EFECTIVO,
      userId: 777,
      idempotencyKey: 'idem-key-6',
    });

    expect(tx.expense.create.mock.calls[0][0].data.userId).toBe(777);
  });
});
