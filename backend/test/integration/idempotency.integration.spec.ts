import {
  ExpenseMedioPago,
  Prisma,
  PrismaClient,
  UserRole,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import * as argon2 from 'argon2';
import { withIdempotency } from '../../src/common/idempotency/idempotency.util';

// T0.14 — prueba real contra Postgres (BLUEPRINT §9.8: nunca con la base
// mockeada, justo lo que hay que probar acá — la violación de unicidad
// real y el reintento — es lo que un mock no reproduce). `expenses` es
// una de las 4 tablas con `idempotency_key` (junto con `sales`,
// `returns`, `cash_movements`); ninguna tiene ticket propio todavía
// (T3.3/T4.5/T5.1/T6.2), así que se usa directo por Prisma para probar
// el mecanismo en sí, no una funcionalidad de negocio.

const prisma = new PrismaClient();

describe('withIdempotency (integration, T0.14)', () => {
  let userId: number;
  let categoryId: number;
  const createdExpenseIds: number[] = [];

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `idempotency-test-${Date.now()}@manitas.local`,
        passwordHash: await argon2.hash('password123'),
        nombre: 'Owner de prueba (idempotencia)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    userId = user.id;

    const category = await prisma.expenseCategory.create({
      data: { nombre: `Categoría Idempotencia Test ${Date.now()}` },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    if (createdExpenseIds.length > 0) {
      await prisma.expense.deleteMany({
        where: { id: { in: createdExpenseIds } },
      });
    }
    await prisma.expenseCategory.delete({ where: { id: categoryId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function createExpense(idempotencyKey: string) {
    return withIdempotency(
      () =>
        prisma.expense.create({
          data: {
            fecha: new Date(),
            idempotencyKey,
            expenseCategoryId: categoryId,
            descripcion: 'Gasto de prueba de idempotencia',
            monto: new Prisma.Decimal('100.00'),
            medioPago: ExpenseMedioPago.EFECTIVO,
            userId,
          },
        }),
      () => prisma.expense.findUnique({ where: { idempotencyKey } }),
    );
  }

  it('con una clave nueva, crea el gasto normalmente', async () => {
    const key = randomUUID();

    const expense = await createExpense(key);
    createdExpenseIds.push(expense.id);

    expect(expense.idempotencyKey).toBe(key);

    const count = await prisma.expense.count({
      where: { idempotencyKey: key },
    });
    expect(count).toBe(1);
  });

  it('BLUEPRINT §9.7: repetir la misma clave no duplica el gasto — devuelve el original', async () => {
    const key = randomUUID();

    const first = await createExpense(key);
    createdExpenseIds.push(first.id);

    const second = await createExpense(key);

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);

    const count = await prisma.expense.count({
      where: { idempotencyKey: key },
    });
    expect(count).toBe(1);
  });

  it('doble click real: dos requests simultáneos con la misma clave — una gana, la otra recibe el mismo resultado, nunca dos filas', async () => {
    const key = randomUUID();

    const [a, b] = await Promise.all([createExpense(key), createExpense(key)]);
    createdExpenseIds.push(a.id);

    expect(a.id).toBe(b.id);

    const count = await prisma.expense.count({
      where: { idempotencyKey: key },
    });
    expect(count).toBe(1);
  });

  it('claves distintas crean gastos distintos (la protección es por clave, no un bloqueo general)', async () => {
    const first = await createExpense(randomUUID());
    const second = await createExpense(randomUUID());
    createdExpenseIds.push(first.id, second.id);

    expect(first.id).not.toBe(second.id);
  });
});
