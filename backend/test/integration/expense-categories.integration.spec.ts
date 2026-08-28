import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

// T6.1 — mismo patrón mecánico que `catalog.integration.spec.ts`
// (brands/categories/sizes/colors): sin Fase 04a (RN-1 de la spec,
// mismo criterio que esos cuatro ABM ya construidos), tests escritos
// en la misma sesión que la implementación.

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

interface ExpenseCategoryBody {
  id: number;
  nombre: string;
  activo: boolean;
  bloqueada: boolean;
}

describe('expense-categories (integration, T6.1)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdCategoryIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
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
        email: 'expense-categories-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba (expense categories)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'expense-categories-test-seller@manitas.local',
        passwordHash,
        nombre: 'Seller de prueba (expense categories)',
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

  describe('GET sin sesión', () => {
    it('da 401', async () => {
      await request(app.getHttpServer()).get('/expense-categories').expect(401);
    });
  });

  it('SELLER puede crear (RN-1: no está en la lista de exclusiones de §5.1)', async () => {
    const response = await sold(
      request(app.getHttpServer()).post('/expense-categories'),
    )
      .send({ nombre: 'Insumos de oficina T6.1' })
      .expect(201);
    const body = response.body as ExpenseCategoryBody;
    createdCategoryIds.push(body.id);

    expect(body).toMatchObject({
      nombre: 'Insumos de oficina T6.1',
      activo: true,
      bloqueada: false,
    });
  });

  it('rechaza un nombre duplicado con 409', async () => {
    const first = await owned(
      request(app.getHttpServer()).post('/expense-categories'),
    )
      .send({ nombre: 'Marketing T6.1' })
      .expect(201);
    createdCategoryIds.push((first.body as ExpenseCategoryBody).id);

    await owned(request(app.getHttpServer()).post('/expense-categories'))
      .send({ nombre: 'Marketing T6.1' })
      .expect(409);
  });

  // AD-7, literal — el caso real de negocio que este chequeo existe
  // para evitar: alguien intentando registrar la compra de mercadería
  // como si fuera un gasto del período.
  it.each([
    'Mercadería T6.1',
    'compra de mercaderia t6.1',
    'MERCADERÍA T6.1',
    'Compra de ropa T6.1',
    'Pago a proveedores T6.1',
  ])(
    'rechaza "%s" al crear — alude a compra de mercadería (AD-7)',
    async (nombre) => {
      await owned(request(app.getHttpServer()).post('/expense-categories'))
        .send({ nombre })
        .expect(400);
    },
  );

  it('PATCH actualiza nombre y permite baja lógica en una categoría no bloqueada', async () => {
    const created = await owned(
      request(app.getHttpServer()).post('/expense-categories'),
    )
      .send({ nombre: 'Capacitación T6.1' })
      .expect(201);
    const id = (created.body as ExpenseCategoryBody).id;
    createdCategoryIds.push(id);

    const renamed = await sold(
      request(app.getHttpServer()).patch(`/expense-categories/${id}`),
    )
      .send({ nombre: 'Capacitación del equipo T6.1' })
      .expect(200);
    expect((renamed.body as ExpenseCategoryBody).nombre).toBe(
      'Capacitación del equipo T6.1',
    );

    const deactivated = await owned(
      request(app.getHttpServer()).patch(`/expense-categories/${id}`),
    )
      .send({ activo: false })
      .expect(200);
    expect((deactivated.body as ExpenseCategoryBody).activo).toBe(false);
  });

  it('PATCH sobre un id inexistente da 404', async () => {
    await owned(
      request(app.getHttpServer()).patch('/expense-categories/999999'),
    )
      .send({ nombre: 'Nadie' })
      .expect(404);
  });

  it('PATCH rechaza un nombre que alude a mercadería, aunque la categoría no esté bloqueada', async () => {
    const created = await owned(
      request(app.getHttpServer()).post('/expense-categories'),
    )
      .send({ nombre: 'Varios T6.1' })
      .expect(201);
    const id = (created.body as ExpenseCategoryBody).id;
    createdCategoryIds.push(id);

    await owned(request(app.getHttpServer()).patch(`/expense-categories/${id}`))
      .send({ nombre: 'Compra de mercadería T6.1' })
      .expect(400);
  });

  it('mass-assignment: un id/bloqueada forzados en el body se rechazan enteros (400)', async () => {
    await owned(request(app.getHttpServer()).post('/expense-categories'))
      .send({ nombre: 'Forzado T6.1', id: 999999, bloqueada: true })
      .expect(400);
  });

  // RN-1 (el corazón de AD-7 a nivel de dato, no solo de texto): las 6
  // categorías seedeadas (`seed.ts`) nacen `bloqueada: true` — este es
  // el único test que ejercita eso contra datos REALES de la base, no
  // una categoría creada por el propio test.
  describe('categoría bloqueada (seedeada — "Otros")', () => {
    let otrosId: number;

    beforeAll(async () => {
      const otros = await prisma.expenseCategory.findUniqueOrThrow({
        where: { nombre: 'Otros' },
      });
      otrosId = otros.id;
      expect(otros.bloqueada).toBe(true);
    });

    it('rechaza renombrarla', async () => {
      await owned(
        request(app.getHttpServer()).patch(`/expense-categories/${otrosId}`),
      )
        .send({ nombre: 'Otros gastos varios' })
        .expect(409);
    });

    it('rechaza desactivarla', async () => {
      await owned(
        request(app.getHttpServer()).patch(`/expense-categories/${otrosId}`),
      )
        .send({ activo: false })
        .expect(409);

      // Confirmado que sigue activa de verdad, no solo que el request
      // dio el status esperado.
      const stillActive = await prisma.expenseCategory.findUniqueOrThrow({
        where: { id: otrosId },
      });
      expect(stillActive.activo).toBe(true);
    });
  });

  it('GET lista ordenada por nombre, incluye activas e inactivas', async () => {
    const response = await owned(
      request(app.getHttpServer()).get('/expense-categories'),
    ).expect(200);
    const body = response.body as ExpenseCategoryBody[];
    const nombres = body.map((c) => c.nombre);
    expect(nombres).toEqual([...nombres].sort((a, b) => a.localeCompare(b)));
    // Las 6 seedeadas siempre están, sin importar qué haya creado este
    // archivo antes.
    expect(nombres).toEqual(
      expect.arrayContaining([
        'Alquiler',
        'Sueldos',
        'Servicios',
        'Impuestos',
        'Mantenimiento',
        'Otros',
      ]),
    );
  });
});
