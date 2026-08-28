import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  CashMovementReferenciaTipo,
  CashMovementTipo,
  CashRegisterSessionEstado,
  ExpenseMedioPago,
  Prisma,
  PrismaClient,
  UserRole,
} from '@prisma/client';
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
//
// ─── T6.3 (Fase 04a) ────────────────────────────────────────────────────
// Extensión de este archivo: fuente única el ticket T6.3 pasado en el
// prompt de esta fase (ROADMAP.md, BLUEPRINT invariantes 7/10). El
// patrón MECÁNICO de apertura/cierre de sesión por HTTP y la limpieza de
// `cash_movements`/sesiones en `afterAll` (reabrir antes de borrar, por
// el trigger de inmutabilidad RN-8) siguen la convención ya establecida
// en `returns.integration.spec.ts`/`sales.integration.spec.ts` — nunca
// su lógica de negocio. El `it.each` del camino feliz de T6.2 se separa
// acá en dos partes: TRANSFERENCIA/OTRO se deja EXACTAMENTE como estaba,
// y EFECTIVO gana la apertura de sesión + verificación del
// `cash_movement`, tal como avisa el comentario propio de T6.2 en ese
// bloque.

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
  // T6.3 — sesiones de caja abiertas por los tests de EFECTIVO.
  const createdSessionIds: number[] = [];

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

  // T6.3 — abre una sesión de caja real por HTTP (`POST
  // /cash-registers/sessions`, sin @Roles — infraestructura de
  // `cash-registers`, ya cerrada, ver `cash-registers.controller.ts`).
  async function abrirSesion(montoInicial = '0.00'): Promise<number> {
    const response = await owned(
      request(app.getHttpServer()).post('/cash-registers/sessions'),
    )
      .send({ montoInicial })
      .expect(201);
    const id = (response.body as { id: number }).id;
    createdSessionIds.push(id);
    return id;
  }

  // T6.3 — mismo patrón que `returns.integration.spec.ts`/
  // `sales.integration.spec.ts`: cierra directo contra la base (sin pasar
  // por el endpoint real) la sesión ABIERTA que haya, si hay alguna. Se
  // usa en `afterEach` para que cada test arranque sin una sesión abierta
  // de un test anterior.
  async function closeAnyOpenSessionDirect(): Promise<void> {
    const open = await prisma.cashRegisterSession.findFirst({
      where: { estado: CashRegisterSessionEstado.ABIERTA },
    });
    if (open) {
      await prisma.cashRegisterSession.update({
        where: { id: open.id },
        data: {
          estado: CashRegisterSessionEstado.CERRADA,
          fechaCierre: new Date(),
          userIdCierre: open.userIdApertura,
          montoDeclarado: open.montoInicial,
          montoSistema: open.montoInicial,
          diferencia: new Prisma.Decimal('0.00'),
        },
      });
      createdSessionIds.push(open.id);
    }
  }

  // T6.3 — precondición determinística para el caso "sin ninguna sesión
  // de caja en absoluto en el sistema (ni abierta ni cerrada)": barre
  // CUALQUIER fila de `cash_register_sessions` que haya quedado (de este
  // archivo o, en teoría, de una corrida anterior interrumpida) y la
  // elimina. Reabre (estado ABIERTA) antes de borrar sus
  // `cash_movements` — el trigger de inmutabilidad (RN-8,
  // `cash_movements_immutable_after_close`) bloquea cualquier escritura,
  // incluido el DELETE, contra `cash_movements` de una sesión CERRADA.
  async function limpiarTodasLasSesiones(): Promise<void> {
    const rows = await prisma.cashRegisterSession.findMany({
      select: { id: true, estado: true },
    });
    for (const row of rows) {
      if (row.estado === CashRegisterSessionEstado.CERRADA) {
        await prisma.cashRegisterSession.update({
          where: { id: row.id },
          data: { estado: CashRegisterSessionEstado.ABIERTA },
        });
      }
      await prisma.cashMovement.deleteMany({ where: { sessionId: row.id } });
      await prisma.cashRegisterSession.delete({ where: { id: row.id } });
    }
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

  // T6.3 — cada test arranca sin sesión de caja abierta de un test
  // anterior (mismo criterio que `returns.integration.spec.ts`). No-op
  // para todos los tests de T6.2 que nunca abren una.
  afterEach(async () => {
    await closeAnyOpenSessionDirect();
  });

  afterAll(async () => {
    // T6.3 — limpieza de `cash_movements`/sesiones ANTES de borrar
    // expenses/usuarios: `cash_register_sessions.user_id_apertura` tiene
    // FK a `users`, así que las sesiones tienen que desaparecer antes que
    // los usuarios de prueba (mismo motivo por el que
    // `returns.integration.spec.ts` reabre-y-borra en el mismo orden).
    await limpiarTodasLasSesiones();

    if (createdExpenseIds.length > 0) {
      await prisma.expense.deleteMany({
        where: { id: { in: createdExpenseIds } },
      });
    }
    if (createdCategoryIds.length > 0) {
      // T6.3 — red de seguridad, no solo `createdExpenseIds`: un test
      // que hoy (implementación ausente) espera 409 y todavía recibe 201
      // (caso correctamente en rojo, ver comentario de fase) crea un
      // gasto cuyo `id` nunca llega a capturarse (la aserción
      // `.expect(409)` corta la cadena `await` antes de leer el body) —
      // sin este segundo `deleteMany` por categoría, ese gasto huérfano
      // deja la FK `expenses_expense_category_id_fkey` bloqueando el
      // borrado de la categoría y tira abajo todo el `afterAll`.
      await prisma.expense.deleteMany({
        where: { expenseCategoryId: { in: createdCategoryIds } },
      });
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
    // T6.3 — reorganizado: hasta T6.2 este `it.each` cubría los TRES
    // medios de pago sin abrir ninguna sesión de caja, con el comentario
    // propio del bloque avisando que EFECTIVO iba a cambiar en T6.3. Acá
    // se separa en dos partes: TRANSFERENCIA/OTRO se queda EXACTAMENTE
    // igual (sin sesión, sigue esperando 201, invariante 10 — "la dueña
    // puede pagar el alquiler un domingo desde su casa"); EFECTIVO pasa a
    // su propio test más abajo, con sesión abierta y verificación del
    // `cash_movement` vinculado.
    it.each([ExpenseMedioPago.TRANSFERENCIA, ExpenseMedioPago.OTRO])(
      'OWNER, categoría activa, medioPago %s → 201, userId del JWT y fecha autogenerada',
      async (medioPago) => {
        const categoriaId = await crearCategoria(
          `Categoría camino feliz ${medioPago} T6.2`,
        );

        const response = await owned(
          request(app.getHttpServer()).post('/expenses'),
        )
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

        // Invariante 10: TRANSFERENCIA/OTRO nunca chequean sesión ni
        // generan `cash_movement`, ni siquiera con T6.3 implementado —
        // eso solo aplica a EFECTIVO.
        const stored = await prisma.expense.findUniqueOrThrow({
          where: { id: body.id },
        });
        expect(stored.userId).toBe(ownerId);
        expect(stored.medioPago).toBe(medioPago);
      },
    );

    // T6.3 — la mitad de este `it.each` que SÍ cambia con este ticket:
    // ahora exige sesión de caja abierta (invariante 10) y genera un
    // `cash_movement` vinculado (invariante 7). Cubre a la vez el punto
    // "EFECTIVO con sesión abierta → 201 + exactamente una fila en
    // cash_movements" pedido en la lista de tests de integración de esta
    // fase — no se duplica en un test aparte.
    it('OWNER, categoría activa, medioPago EFECTIVO, sesión de caja abierta → 201, y existe EXACTAMENTE un cash_movement GASTO vinculado (monto negativo, referenciaTipo EXPENSE, referenciaId = id del gasto)', async () => {
      const sessionId = await abrirSesion('500.00');
      const categoriaId = await crearCategoria(
        'Categoría camino feliz EFECTIVO T6.3',
      );

      const response = await owned(
        request(app.getHttpServer()).post('/expenses'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: categoriaId,
          descripcion: 'Gasto de prueba EFECTIVO',
          monto: '1234.56',
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(201);

      const body = response.body as ExpenseBody;
      createdExpenseIds.push(body.id);

      expect(body).toMatchObject({
        expenseCategoryId: categoriaId,
        descripcion: 'Gasto de prueba EFECTIVO',
        medioPago: ExpenseMedioPago.EFECTIVO,
        userId: ownerId,
      });
      expect(Number(body.monto)).toBeCloseTo(1234.56, 2);
      expect(body.fecha).toBeDefined();

      const stored = await prisma.expense.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(stored.userId).toBe(ownerId);
      expect(stored.medioPago).toBe(ExpenseMedioPago.EFECTIVO);

      const movimientos = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.EXPENSE,
          referenciaId: body.id,
        },
      });
      expect(movimientos).toHaveLength(1);
      const movimiento = movimientos[0];
      expect(movimiento.sessionId).toBe(sessionId);
      expect(movimiento.tipo).toBe(CashMovementTipo.GASTO);
      expect(movimiento.descripcion).toBe('Gasto de prueba EFECTIVO');
      expect(movimiento.userId).toBe(ownerId);
      // El signo negativo lo aplica `registrarMovimiento` internamente
      // (quien llama siempre manda el monto positivo) — acá se confirma
      // el resultado final persistido: negativo, mismo valor absoluto
      // que el gasto.
      expect(movimiento.monto.isNegative()).toBe(true);
      expect(movimiento.monto.abs().toString()).toBe(
        new Prisma.Decimal('1234.56').toString(),
      );
    });

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
      const response = await owned(
        request(app.getHttpServer()).post('/expenses'),
      )
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

      const response = await owned(
        request(app.getHttpServer()).post('/expenses'),
      )
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
    it('doble POST con el mismo Idempotency-Key → misma fila devuelta, sin segunda fila en la base', async () => {
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
        .send(body);
      // [200, 201] — no [200] a secas: el propio controller nunca
      // distingue el status según si `withIdempotency` creó la fila o
      // devolvió la existente (NestJS responde 201 por default en TODO
      // `@Post()`, sin un `@Res()` condicional para este caso). Mismo
      // criterio ya establecido y auditado en `sales-controller.
      // integration.spec.ts` ("caso 5 — doble click... responde
      // 200/201"): la garantía real de BLUEPRINT §9.7 ("se devuelve la
      // operación original con 200") se cumple al nivel de DATOS —
      // mismo `id`, una sola fila — no al nivel de status HTTP exacto.
      expect([200, 201]).toContain(second.status);

      expect((second.body as ExpenseBody).id).toBe(
        (first.body as ExpenseBody).id,
      );

      const count = await prisma.expense.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });
  });

  // T6.3 — invariante 10 ("los gastos solo requieren sesión abierta si se
  // pagan en efectivo desde la caja") + invariante 7 (GASTO tiene su
  // propio origen, no depende de la regla EFECTIVO-solo de
  // payments/return_payments). El camino feliz de EFECTIVO (201 + un
  // solo cash_movement) ya se cubrió arriba, reorganizando el `it.each`
  // de T6.2 — acá van los casos que ese bloque no cubre.
  describe('POST /expenses — T6.3 (sesión de caja y cash_movement en EFECTIVO)', () => {
    it('EFECTIVO sin sesión de caja abierta (nunca hubo ninguna) → 409, sin crear ni el gasto ni ningún cash_movement', async () => {
      const categoriaId = await crearCategoria(
        'Categoría EFECTIVO sin sesión T6.3',
      );
      const descripcion = 'Gasto EFECTIVO sin sesión abierta T6.3';

      await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: categoriaId,
          descripcion,
          monto: '250.00',
          medioPago: ExpenseMedioPago.EFECTIVO,
        })
        .expect(409);

      const count = await prisma.expense.count({ where: { descripcion } });
      expect(count).toBe(0);
    });

    it('TRANSFERENCIA/OTRO, sin ninguna sesión de caja en absoluto en el sistema (ni abierta ni cerrada) → sigue aceptándose (201), cero cash_movements para ese gasto', async () => {
      // Precondición determinística (ver comentario de
      // `limpiarTodasLasSesiones`): cero sesiones en TODO el sistema,
      // no solo "ninguna abierta" — es justo lo que este caso necesita
      // probar (que TRANSFERENCIA/OTRO ni siquiera miran si existe una).
      await limpiarTodasLasSesiones();
      expect(await prisma.cashRegisterSession.count()).toBe(0);

      const categoriaId = await crearCategoria(
        'Categoría TRANSFERENCIA sin sesiones T6.3',
      );

      const response = await owned(
        request(app.getHttpServer()).post('/expenses'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          expenseCategoryId: categoriaId,
          descripcion: 'Gasto TRANSFERENCIA sin sesiones en el sistema',
          monto: '75.00',
          medioPago: ExpenseMedioPago.TRANSFERENCIA,
        })
        .expect(201);

      const body = response.body as ExpenseBody;
      createdExpenseIds.push(body.id);

      const movimientos = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.EXPENSE,
          referenciaId: body.id,
        },
      });
      expect(movimientos).toHaveLength(0);
      expect(await prisma.cashRegisterSession.count()).toBe(0);
    });

    it('doble POST (mismo Idempotency-Key) de un gasto EFECTIVO con sesión abierta → sigue existiendo UNA sola fila en expenses Y UNA sola fila en cash_movements (la idempotencia alcanza también al movimiento de caja)', async () => {
      await abrirSesion('1000.00');
      const categoriaId = await crearCategoria(
        'Categoría idempotencia EFECTIVO T6.3',
      );
      const key = randomUUID();
      const body = {
        expenseCategoryId: categoriaId,
        descripcion: 'Doble click en gasto EFECTIVO T6.3',
        monto: '450.00',
        medioPago: ExpenseMedioPago.EFECTIVO,
      };

      const first = await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(first.status);
      const firstBody = first.body as ExpenseBody;
      createdExpenseIds.push(firstBody.id);

      const second = await owned(request(app.getHttpServer()).post('/expenses'))
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(second.status);
      expect((second.body as ExpenseBody).id).toBe(firstBody.id);

      const expenseCount = await prisma.expense.count({
        where: { idempotencyKey: key },
      });
      expect(expenseCount).toBe(1);

      const movimientos = await prisma.cashMovement.findMany({
        where: {
          referenciaTipo: CashMovementReferenciaTipo.EXPENSE,
          referenciaId: firstBody.id,
        },
      });
      expect(movimientos).toHaveLength(1);
      expect(movimientos[0].tipo).toBe(CashMovementTipo.GASTO);
    });
  });

  describe('POST /expenses — mass-assignment', () => {
    it('id/userId/idempotencyKey forzados en el body se rechazan enteros (400) — el DTO solo acepta expenseCategoryId/descripcion/monto/medioPago', async () => {
      const categoriaId = await crearCategoria(
        'Categoría mass-assignment T6.2',
      );

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

  // Cobertura agregada en la Fase 04 (implementación), no parte del
  // contrato mínimo de la Fase 04a: `findAll` con paginación y filtro
  // `desde`/`hasta` completa el contrato de `GET /expenses` de la spec
  // del módulo, sección 4 — se testea acá porque es código nuevo de
  // este mismo ticket (CLAUDE.md regla 8), aunque la Fase04a no lo haya
  // exigido explícitamente.
  describe('GET /expenses — paginación y filtro por fecha (sección 4 de la spec)', () => {
    async function crearGastoDirecto(
      categoriaId: number,
      fecha: Date,
      monto = '10.00',
    ): Promise<number> {
      const gasto = await prisma.expense.create({
        data: {
          fecha,
          idempotencyKey: randomUUID(),
          expenseCategoryId: categoriaId,
          descripcion: 'Gasto de prueba (fixture directo)',
          monto,
          medioPago: ExpenseMedioPago.OTRO,
          userId: ownerId,
        },
      });
      createdExpenseIds.push(gasto.id);
      return gasto.id;
    }

    it('devuelve la forma paginada (items/itemCount/page/pageSize)', async () => {
      const categoriaId = await crearCategoria('Categoría paginación T6.2');
      await crearGastoDirecto(categoriaId, new Date('2026-01-10T12:00:00Z'));

      const response = await owned(
        request(app.getHttpServer()).get('/expenses?page=1&pageSize=5'),
      ).expect(200);

      const body = response.body as {
        items: unknown[];
        itemCount: number;
        page: number;
        pageSize: number;
      };
      expect(Array.isArray(body.items)).toBe(true);
      expect(typeof body.itemCount).toBe('number');
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(5);
    });

    it('ordena por fecha descendente — "lo último siempre arriba" (§12.4)', async () => {
      const categoriaId = await crearCategoria('Categoría orden T6.2');
      const viejoId = await crearGastoDirecto(
        categoriaId,
        new Date('2026-02-01T00:00:00Z'),
      );
      const nuevoId = await crearGastoDirecto(
        categoriaId,
        new Date('2026-02-20T00:00:00Z'),
      );

      const response = await owned(
        request(app.getHttpServer()).get(
          `/expenses?pageSize=100&desde=2026-02-01&hasta=2026-02-28`,
        ),
      ).expect(200);

      const ids = (response.body as { items: ExpenseBody[] }).items.map(
        (item) => item.id,
      );
      const posNuevo = ids.indexOf(nuevoId);
      const posViejo = ids.indexOf(viejoId);
      expect(posNuevo).toBeGreaterThanOrEqual(0);
      expect(posViejo).toBeGreaterThanOrEqual(0);
      expect(posNuevo).toBeLessThan(posViejo);
    });

    it('desde/hasta filtran por fecha — un gasto fuera del rango no aparece', async () => {
      const categoriaId = await crearCategoria('Categoría filtro T6.2');
      const dentroId = await crearGastoDirecto(
        categoriaId,
        new Date('2026-03-15T00:00:00Z'),
      );
      const fueraId = await crearGastoDirecto(
        categoriaId,
        new Date('2026-04-15T00:00:00Z'),
      );

      const response = await owned(
        request(app.getHttpServer()).get(
          '/expenses?pageSize=100&desde=2026-03-01&hasta=2026-03-31',
        ),
      ).expect(200);

      const ids = (response.body as { items: ExpenseBody[] }).items.map(
        (item) => item.id,
      );
      expect(ids).toContain(dentroId);
      expect(ids).not.toContain(fueraId);
    });

    it('sin desde/hasta trae todo, sin filtrar', async () => {
      const categoriaId = await crearCategoria('Categoría sin filtro T6.2');
      const id = await crearGastoDirecto(
        categoriaId,
        new Date('2020-01-01T00:00:00Z'),
      );

      const response = await owned(
        request(app.getHttpServer()).get('/expenses?pageSize=100'),
      ).expect(200);

      const ids = (response.body as { items: ExpenseBody[] }).items.map(
        (item) => item.id,
      );
      expect(ids).toContain(id);
    });
  });
});
