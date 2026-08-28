import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ExpenseMedioPago, PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';

// T6.2 — Fase 04a (tests primero), sesión aislada. Fuente única: el
// ticket T6.2 pasado en el prompt de esta fase (`ROADMAP.md`, BLUEPRINT
// §9.3/§9.4/§9.7 e invariante 10, tabla de errores de la spec del
// módulo sección 7). NO se leyó ninguna implementación de `expenses` —
// solo la ESTRUCTURA mecánica de `expense-categories.integration.spec.ts`
// (setup de usuarios/cookies) y `cash-registers.integration.spec.ts`
// (patrón de `Idempotency-Key`/doble-click) como convención del repo.
//
// Explícitamente FUERA de alcance de T6.2 (no se testea ni como si
// debiera pasar ni como si debiera fallar): chequeo de sesión de caja
// abierta y creación de `cash_movement` para ningún `medioPago`,
// incluido EFECTIVO — eso es T6.3.

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

interface ExpenseBody {
  id: number;
  expenseCategoryId: number;
  descripcion: string;
  monto: string;
  medioPago: ExpenseMedioPago;
  userId: number;
  fecha: string;
}

interface ExpenseCategoryBody {
  id: number;
  nombre: string;
  activo: boolean;
}

describe('expenses (integration, T6.2)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  let ownerId: number;
  const createdUserIds: number[] = [];
  const createdCategoryIds: number[] = [];
  const createdExpenseIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  async function crearCategoria(nombre: string): Promise<number> {
    const response = await owned(
      request(app.getHttpServer()).post('/expense-categories'),
    )
      .send({ nombre })
      .expect(201);
    const id = (response.body as ExpenseCategoryBody).id;
    createdCategoryIds.push(id);
    return id;
  }

  async function desactivarCategoria(id: number): Promise<void> {
    await owned(request(app.getHttpServer()).patch(`/expense-categories/${id}`))
      .send({ activo: false })
      .expect(200);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: 'expenses-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba (expenses)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);
    ownerId = owner.id;

    const seller = await prisma.user.create({
      data: {
        email: 'expenses-test-seller@manitas.local',
        passwordHash,
        nombre: 'Seller de prueba (expenses)',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    createdUserIds.push(seller.id);

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: 'password123' })
      .expect(200);
    ownerCookie = extractCookie(ownerLogin.headers['set-cookie']);

    const sellerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: seller.email, password: 'password123' })
      .expect(200);
    sellerCookie = extractCookie(sellerLogin.headers['set-cookie']);
  });

  afterAll(async () => {
    if (createdExpenseIds.length > 0) {
      await prisma.expense.deleteMany({
        where: { id: { in: createdExpenseIds } },
      });
    }
    if (createdCategoryIds.length > 0) {
      await prisma.expenseCategory.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('autenticación y rol (RN-2/RN-11 — OWNER-only en todo /expenses)', () => {
    it('POST sin sesión → 401', async () => {
      await request(app.getHttpServer())
        .post('/expenses')
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: 1,
          descripcion: 'x',
          monto: '10.00',
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(401);
    });

    it('GET sin sesión → 401', async () => {
      await request(app.getHttpServer()).get('/expenses').expect(401);
    });

    it('POST con SELLER → 403', async () => {
      const categoriaId = await crearCategoria('Categoría 403 POST T6.2');

      await sold(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: categoriaId,
          descripcion: 'Intento de SELLER',
          monto: '10.00',
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(403);
    });

    it('GET con SELLER → 403', async () => {
      await sold(request(app.getHttpServer()).get('/expenses')).expect(403);
    });
  });

  describe('POST /expenses — camino feliz (RN-2, §9.3, §9.7)', () => {
    it.each([
      ExpenseMedioPago.EFECTIVO,
      ExpenseMedioPago.TRANSFERENCIA,
      ExpenseMedioPago.OTRO,
    ])(
      'OWNER, categoría activa, medioPago %s → 201, userId del JWT y fecha autogenerada',
      async (medioPago) => {
        const categoriaId = await crearCategoria(
          `Categoría camino feliz ${medioPago} T6.2`,
        );

        const response = await owned(request(app.getHttpServer()).post('/expenses'))
          .set('Idempotency-Key', randomUUID())
          .send({
            expenseCategoryId: categoriaId,
            descripcion: `Gasto de prueba ${medioPago}`,
            monto: '1234.56',
            medioPago,
          })
          .expect(201);

        const body = response.body as ExpenseBody;
        createdExpenseIds.push(body.id);

        expect(body).toMatchObject({
          expenseCategoryId: categoriaId,
          descripcion: `Gasto de prueba ${medioPago}`,
          medioPago,
          userId: ownerId,
        });
        expect(Number(body.monto)).toBeCloseTo(1234.56, 2);
        expect(body.fecha).toBeDefined();

        // Invariante 10 (mitad de T6.2): un gasto en efectivo se acepta
        // igual sin sesión de caja abierta en esta fase — eso lo
        // restringe T6.3, no éste. No se verifica ningún
        // `cash_movement` acá a propósito.
        const stored = await prisma.expense.findUniqueOrThrow({
          where: { id: body.id },
        });
        expect(stored.userId).toBe(ownerId);
        expect(stored.medioPago).toBe(medioPago);
      },
    );

    it('sin header Idempotency-Key → 400 (mismo contrato que cash-registers)', async () => {
      const categoriaId = await crearCategoria('Categoría sin header T6.2');

      await owned(request(app.getHttpServer()).post('/expenses'))
        .send({
          expenseCategoryId: categoriaId,
          descripcion: 'Sin header',
          monto: '10.00',
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(400);
    });
  });

  describe('POST /expenses — errores de categoría (tabla sección 7)', () => {
    it('categoría inexistente → 404 "Categoría de gasto no encontrada"', async () => {
      const response = await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: 9999999,
          descripcion: 'Categoría inexistente',
          monto: '10.00',
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(404);

      expect((response.body as { message: string }).message).toBe(
        'Categoría de gasto no encontrada',
      );
    });

    it('categoría inactiva → 400 "Esta categoría de gasto está desactivada"', async () => {
      const categoriaId = await crearCategoria('Categoría inactiva T6.2');
      await desactivarCategoria(categoriaId);

      const response = await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: categoriaId,
          descripcion: 'Categoría inactiva',
          monto: '10.00',
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(400);

      expect((response.body as { message: string }).message).toBe(
        'Esta categoría de gasto está desactivada',
      );
    });
  });

  describe('POST /expenses — validación de monto (§9.3)', () => {
    it.each(['0', '-1', '-100.50'])('monto "%s" (≤ 0) → 400', async (monto) => {
      const categoriaId = await crearCategoria(`Categoría monto ${monto} T6.2`);

      await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: categoriaId,
          descripcion: 'Monto inválido',
          monto,
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(400);
    });

    it.each(['10.123', '99.999'])(
      'monto "%s" (más de 2 decimales) → 400',
      async (monto) => {
        const categoriaId = await crearCategoria(
          `Categoría precisión ${monto} T6.2`,
        );

        await owned(request(app.getHttpServer()).post('/expenses'))
          .set('Idempotency-Key', randomUUID())
          .send({
            expenseCategoryId: categoriaId,
            descripcion: 'Más de 2 decimales',
            monto,
            medioPago: ExpenseMedioPago.EFECTIVO,
          })
          .expect(400);
      },
    );
  });

  describe('POST /expenses — idempotencia (§9.7)', () => {
    it('doble POST con el mismo Idempotency-Key → segunda respuesta 200 con el mismo id, sin segunda fila en la base', async () => {
      const categoriaId = await crearCategoria('Categoría idempotencia T6.2');
      const key = randomUUID();
      const body = {
        expenseCategoryId: categoriaId,
        descripcion: 'Doble click en gasto',
        monto: '300.00',
        medioPago: ExpenseMedioPago.TRANSFERENCIA,
      };

      const first = await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(first.status);
      createdExpenseIds.push((first.body as ExpenseBody).id);

      const second = await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', key)
        .send(body)
        .expect(200);

      expect((second.body as ExpenseBody).id).toBe(
        (first.body as ExpenseBody).id,
      );

      const count = await prisma.expense.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });
  });

  describe('POST /expenses — mass-assignment', () => {
    it('id/userId/idempotencyKey forzados en el body se rechazan enteros (400) — el DTO solo acepta expenseCategoryId/descripcion/monto/medioPago', async () => {
      const categoriaId = await crearCategoria('Categoría mass-assignment T6.2');

      await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: categoriaId,
          descripcion: 'Forzado',
          monto: '10.00',
          medioPago: ExpenseMedioPago.EFECTIVO,
          id: 999999,
          userId: 1,
          idempotencyKey: 'forzado-a-mano',
        })
        .expect(400);
    });
  });

  describe('GET /expenses', () => {
    it('OWNER → 200 (sin fijar la forma exacta de la paginación en este ticket)', async () => {
      await owned(request(app.getHttpServer()).get('/expenses')).expect(200);
    });
  });
});
