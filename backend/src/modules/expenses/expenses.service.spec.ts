import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovementReferenciaTipo,
  CashMovementTipo,
  ExpenseMedioPago,
  Prisma,
} from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CashRegisterService } from '../cash-registers/cash-register.service';
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
//
// ─── T6.3 (Fase 04a) ────────────────────────────────────────────────────
// Extensión de este archivo: NO se leyó ningún cambio de
// `expenses.service.ts` más allá del cambio ESTRUCTURAL ya cerrado en
// esta misma fase (segundo parámetro del constructor,
// `cashRegisterService: CashRegisterService`, cuerpo de `registrarGasto`
// SIN TOCAR). Fuente única de la lógica nueva: el ticket T6.3 pasado en
// el prompt de esta fase (ROADMAP.md, BLUEPRINT invariantes 7 y 10). El
// patrón MECÁNICO de mock de `cashRegisterService` (forma de
// `SessionRow`/`buildSessionRow`, mock tipado de
// `getSesionAbiertaOrThrow`/`registrarMovimiento`) sigue
// `returns.service.spec.ts` (T5.3) — nunca su lógica de negocio.

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

// T6.3 — mismo shape mínimo que `SessionRow` de
// `returns.service.spec.ts`: solo lo que `ExpensesService` necesitaría
// leer de la sesión abierta (su `id`, para `sessionId` del movimiento).
interface SessionRow {
  id: number;
  estado: 'ABIERTA' | 'CERRADA';
}

function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return { id: 55, estado: 'ABIERTA', ...overrides };
}

interface CashMovementRow {
  id: number;
}

interface MockCashRegisterService {
  getSesionAbiertaOrThrow: jest.Mock<Promise<SessionRow>, [unknown]>;
  registrarMovimiento: jest.Mock<Promise<CashMovementRow>, [unknown, unknown]>;
}

// Por default resuelve con una sesión abierta — mismo criterio que
// `buildDeps()` en `returns.service.spec.ts` (el "camino feliz" es el
// default; los tests que necesitan el rechazo lo pisan explícitamente
// con `.mockRejectedValue(...)`).
function buildMockCashRegisterService(): MockCashRegisterService {
  return {
    getSesionAbiertaOrThrow: jest
      .fn<Promise<SessionRow>, [unknown]>()
      .mockResolvedValue(buildSessionRow()),
    registrarMovimiento: jest
      .fn<Promise<CashMovementRow>, [unknown, unknown]>()
      .mockResolvedValue({ id: 777 }),
  };
}

function buildService(
  cashRegisterService: MockCashRegisterService = buildMockCashRegisterService(),
): ExpensesService {
  return new ExpensesService(
    {} as unknown as PrismaService,
    cashRegisterService as unknown as CashRegisterService,
  );
}

describe('ExpensesService.registrarGasto (T6.2)', () => {
  let service: ExpensesService;

  beforeEach(() => {
    service = buildService();
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

    await service.registrarGasto(tx as unknown as Prisma.TransactionClient, {
      expenseCategoryId: 3,
      descripcion: 'Gasto x',
      monto: '100.00',
      medioPago: ExpenseMedioPago.EFECTIVO,
      userId: 1,
      idempotencyKey: 'idem-key-repetida',
    });

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

// T6.3 — invariante 10 ("los gastos solo requieren sesión abierta si se
// pagan en efectivo desde la caja") + invariante 7 (GASTO tiene su propio
// origen, ver `cash-register.service.ts`). Spec del módulo, sección 5,
// orden textual: validar monto → validar categoría → (NUEVO, solo
// EFECTIVO) `getSesionAbiertaOrThrow` fail-fast → crear el gasto → (NUEVO,
// solo EFECTIVO) `registrarMovimiento` vinculado.
describe('ExpensesService.registrarGasto — T6.3 (efectivo → movimiento de caja)', () => {
  it('medioPago EFECTIVO con sesión abierta: llama getSesionAbiertaOrThrow(tx) y luego registrarMovimiento(tx, {...}) exactamente una vez cada uno, con el monto/descr/userId del propio gasto y referenciaId = id del gasto recién creado', async () => {
    const tx = buildMockTx(buildCategoria());
    const cashRegisterService = buildMockCashRegisterService();
    const service = buildService(cashRegisterService);

    const result = await service.registrarGasto(
      tx as unknown as Prisma.TransactionClient,
      {
        expenseCategoryId: 3,
        descripcion: 'Pago de luz en efectivo',
        monto: '850.00',
        medioPago: ExpenseMedioPago.EFECTIVO,
        userId: 42,
        idempotencyKey: 'idem-key-t63-1',
      },
    );

    expect(cashRegisterService.getSesionAbiertaOrThrow).toHaveBeenCalledTimes(
      1,
    );
    expect(cashRegisterService.getSesionAbiertaOrThrow).toHaveBeenCalledWith(
      tx,
    );

    expect(tx.expense.create).toHaveBeenCalledTimes(1);

    expect(cashRegisterService.registrarMovimiento).toHaveBeenCalledTimes(1);
    // `monto` no va en este `objectContaining` — se verifica aparte,
    // abajo, con el valor exacto (evita `expect.anything()` anidado
    // dentro del objeto, que dispara `no-unsafe-assignment`: mismo
    // criterio que ya usa `returns.service.spec.ts` con
    // `expect.objectContaining` para no fijar cada campo).
    expect(cashRegisterService.registrarMovimiento).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        sessionId: 55,
        tipo: CashMovementTipo.GASTO,
        referenciaTipo: CashMovementReferenciaTipo.EXPENSE,
        referenciaId: result.id,
        descripcion: 'Pago de luz en efectivo',
        userId: 42,
      }),
    );
    const call = cashRegisterService.registrarMovimiento.mock.calls[0][1];
    expect(
      new Prisma.Decimal(
        (call as { monto: Prisma.Decimal.Value }).monto,
      ).toString(),
    ).toBe('850');
  });

  it('medioPago EFECTIVO, sin sesión abierta (getSesionAbiertaOrThrow rechaza con 409): el método propaga el rechazo, tx.expense.create NUNCA se llama, registrarMovimiento NUNCA se llama', async () => {
    const tx = buildMockTx(buildCategoria());
    const cashRegisterService = buildMockCashRegisterService();
    cashRegisterService.getSesionAbiertaOrThrow.mockRejectedValue(
      new ConflictException('No hay una sesión de caja abierta'),
    );
    const service = buildService(cashRegisterService);

    const call = service.registrarGasto(
      tx as unknown as Prisma.TransactionClient,
      {
        expenseCategoryId: 3,
        descripcion: 'Gasto sin sesión',
        monto: '100.00',
        medioPago: ExpenseMedioPago.EFECTIVO,
        userId: 1,
        idempotencyKey: 'idem-key-t63-2',
      },
    );

    await expect(call).rejects.toBeInstanceOf(ConflictException);
    await expect(call).rejects.toThrow('No hay una sesión de caja abierta');
    expect(tx.expense.create).not.toHaveBeenCalled();
    expect(cashRegisterService.registrarMovimiento).not.toHaveBeenCalled();
  });

  it.each([ExpenseMedioPago.TRANSFERENCIA, ExpenseMedioPago.OTRO])(
    'medioPago %s: ni getSesionAbiertaOrThrow ni registrarMovimiento se llaman nunca, el gasto se crea igual (comportamiento de T6.2, sin cambios)',
    async (medioPago) => {
      const tx = buildMockTx(buildCategoria());
      const cashRegisterService = buildMockCashRegisterService();
      const service = buildService(cashRegisterService);

      const result = await service.registrarGasto(
        tx as unknown as Prisma.TransactionClient,
        {
          expenseCategoryId: 3,
          descripcion: 'Pago que no toca caja',
          monto: '100.00',
          medioPago,
          userId: 1,
          idempotencyKey: 'idem-key-t63-3',
        },
      );

      expect(
        cashRegisterService.getSesionAbiertaOrThrow,
      ).not.toHaveBeenCalled();
      expect(cashRegisterService.registrarMovimiento).not.toHaveBeenCalled();
      expect(tx.expense.create).toHaveBeenCalledTimes(1);
      expect(result.medioPago).toBe(medioPago);
    },
  );
});

// Cobertura agregada en la Fase 04 (implementación): `findAll` no forma
// parte del contrato mínimo que exigió la Fase04a (esa fase solo probó
// `GET /expenses` de punta a punta contra Postgres real, sin fijar el
// detalle interno) — se testea acá a nivel unitario porque es código
// nuevo de este mismo ticket (CLAUDE.md regla 8: los tests se escriben
// en el mismo ticket que el código).
describe('ExpensesService.findAll (T6.2)', () => {
  interface FindManyArgs {
    where: { fecha?: { gte?: Date; lte?: Date } };
    orderBy: { fecha: 'desc' };
    skip: number;
    take: number;
  }

  interface MockPrisma {
    expense: {
      findMany: jest.Mock<Promise<ExpenseRow[]>, [FindManyArgs]>;
      count: jest.Mock<Promise<number>, [{ where: FindManyArgs['where'] }]>;
    };
  }

  function buildMockPrisma(): MockPrisma {
    return {
      expense: {
        findMany: jest
          .fn<Promise<ExpenseRow[]>, [FindManyArgs]>()
          .mockResolvedValue([]),
        count: jest
          .fn<Promise<number>, [{ where: FindManyArgs['where'] }]>()
          .mockResolvedValue(0),
      },
    };
  }

  it('pagina con skip/take derivados de page/pageSize, ordena por fecha descendente', async () => {
    const prisma = buildMockPrisma();
    const service = new ExpensesService(
      prisma as unknown as PrismaService,
      buildMockCashRegisterService() as unknown as CashRegisterService,
    );

    await service.findAll({ page: 3, pageSize: 10 });

    expect(prisma.expense.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { fecha: 'desc' },
      skip: 20,
      take: 10,
    });
  });

  it('sin desde/hasta, el where no filtra por fecha', async () => {
    const prisma = buildMockPrisma();
    const service = new ExpensesService(
      prisma as unknown as PrismaService,
      buildMockCashRegisterService() as unknown as CashRegisterService,
    );

    await service.findAll({ page: 1, pageSize: 20 });

    const call = prisma.expense.findMany.mock.calls[0][0];
    expect(call.where).toEqual({});
  });

  it('con desde y hasta, filtra fecha con gte/lte', async () => {
    const prisma = buildMockPrisma();
    const service = new ExpensesService(
      prisma as unknown as PrismaService,
      buildMockCashRegisterService() as unknown as CashRegisterService,
    );
    const desde = new Date('2026-01-01T00:00:00Z');
    const hasta = new Date('2026-01-31T23:59:59Z');

    await service.findAll({ page: 1, pageSize: 20, desde, hasta });

    const call = prisma.expense.findMany.mock.calls[0][0];
    expect(call.where.fecha).toEqual({ gte: desde, lte: hasta });
  });

  it('devuelve items/itemCount/page/pageSize', async () => {
    const prisma = buildMockPrisma();
    prisma.expense.count.mockResolvedValue(42);
    const service = new ExpensesService(
      prisma as unknown as PrismaService,
      buildMockCashRegisterService() as unknown as CashRegisterService,
    );

    const result = await service.findAll({ page: 2, pageSize: 15 });

    expect(result).toEqual({
      items: [],
      itemCount: 42,
      page: 2,
      pageSize: 15,
    });
  });
});
