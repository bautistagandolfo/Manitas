import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('Catálogo — brands/categories/sizes/colors (integration)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdBrandIds: number[] = [];
  const createdCategoryIds: number[] = [];
  const createdSizeIds: number[] = [];
  const createdColorIds: number[] = [];

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
        email: 'catalog-test-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'catalog-test-seller@manitas.local',
        passwordHash,
        nombre: 'Seller de prueba',
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
    if (createdBrandIds.length > 0) {
      await prisma.brand.deleteMany({ where: { id: { in: createdBrandIds } } });
    }
    if (createdCategoryIds.length > 0) {
      await prisma.category.deleteMany({
        where: { id: { in: createdCategoryIds } },
      });
    }
    if (createdSizeIds.length > 0) {
      await prisma.size.deleteMany({ where: { id: { in: createdSizeIds } } });
    }
    if (createdColorIds.length > 0) {
      await prisma.color.deleteMany({ where: { id: { in: createdColorIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('GET sin sesión', () => {
    it('/brands, /categories, /sizes, /colors dan 401', async () => {
      await request(app.getHttpServer()).get('/brands').expect(401);
      await request(app.getHttpServer()).get('/categories').expect(401);
      await request(app.getHttpServer()).get('/sizes').expect(401);
      await request(app.getHttpServer()).get('/colors').expect(401);
    });
  });

  describe('brands', () => {
    it('SELLER puede crear (RN de la spec: no está en la lista de exclusiones de §5.1)', async () => {
      const response = await sold(request(app.getHttpServer()).post('/brands'))
        .send({ nombre: 'Nike Catalog Test' })
        .expect(201);
      createdBrandIds.push((response.body as { id: number }).id);

      expect(response.body).toMatchObject({
        nombre: 'Nike Catalog Test',
        activo: true,
      });
    });

    it('rechaza un nombre duplicado con 409', async () => {
      const first = await owned(request(app.getHttpServer()).post('/brands'))
        .send({ nombre: 'Adidas Catalog Test' })
        .expect(201);
      createdBrandIds.push((first.body as { id: number }).id);

      await owned(request(app.getHttpServer()).post('/brands'))
        .send({ nombre: 'Adidas Catalog Test' })
        .expect(409);
    });

    it('PATCH actualiza nombre y permite baja lógica', async () => {
      const created = await owned(request(app.getHttpServer()).post('/brands'))
        .send({ nombre: 'Puma Catalog Test' })
        .expect(201);
      const id = (created.body as { id: number }).id;
      createdBrandIds.push(id);

      const updated = await sold(
        request(app.getHttpServer()).patch(`/brands/${id}`),
      )
        .send({ activo: false })
        .expect(200);
      expect((updated.body as { activo: boolean }).activo).toBe(false);
    });

    it('PATCH sobre un id inexistente da 404', async () => {
      await owned(request(app.getHttpServer()).patch('/brands/999999'))
        .send({ nombre: 'Nadie' })
        .expect(404);
    });

    it('mass-assignment: un id forzado en el body se rechaza entero (400)', async () => {
      await owned(request(app.getHttpServer()).post('/brands'))
        .send({ nombre: 'Reebok Catalog Test', id: 999999 })
        .expect(400);
    });

    it('GET lista ordenada por nombre', async () => {
      const response = await owned(
        request(app.getHttpServer()).get('/brands'),
      ).expect(200);
      const body = response.body as { nombre: string }[];
      const nombres = body.map((b) => b.nombre);
      expect(nombres).toEqual([...nombres].sort((a, b) => a.localeCompare(b)));
    });
  });

  describe('categories', () => {
    it('crea, rechaza duplicado, actualiza', async () => {
      const created = await owned(
        request(app.getHttpServer()).post('/categories'),
      )
        .send({ nombre: 'Remeras Catalog Test' })
        .expect(201);
      const id = (created.body as { id: number }).id;
      createdCategoryIds.push(id);

      await sold(request(app.getHttpServer()).post('/categories'))
        .send({ nombre: 'Remeras Catalog Test' })
        .expect(409);

      const updated = await owned(
        request(app.getHttpServer()).patch(`/categories/${id}`),
      )
        .send({ nombre: 'Remeras Estampadas' })
        .expect(200);
      expect((updated.body as { nombre: string }).nombre).toBe(
        'Remeras Estampadas',
      );
    });
  });

  describe('colors', () => {
    it('crea, rechaza duplicado, actualiza', async () => {
      const created = await owned(request(app.getHttpServer()).post('/colors'))
        .send({ nombre: 'Negro Catalog Test' })
        .expect(201);
      const id = (created.body as { id: number }).id;
      createdColorIds.push(id);

      await sold(request(app.getHttpServer()).post('/colors'))
        .send({ nombre: 'Negro Catalog Test' })
        .expect(409);

      const updated = await owned(
        request(app.getHttpServer()).patch(`/colors/${id}`),
      )
        .send({ activo: false })
        .expect(200);
      expect((updated.body as { activo: boolean }).activo).toBe(false);
    });
  });

  describe('sizes', () => {
    it('exige `orden` al crear', async () => {
      await owned(request(app.getHttpServer()).post('/sizes'))
        .send({ nombre: 'Talle sin orden' })
        .expect(400);
    });

    it('crea con orden, rechaza nombre duplicado, actualiza el orden', async () => {
      const created = await owned(request(app.getHttpServer()).post('/sizes'))
        .send({ nombre: 'XXL Catalog Test', orden: 99 })
        .expect(201);
      const id = (created.body as { id: number }).id;
      createdSizeIds.push(id);

      await sold(request(app.getHttpServer()).post('/sizes'))
        .send({ nombre: 'XXL Catalog Test', orden: 100 })
        .expect(409);

      const updated = await owned(
        request(app.getHttpServer()).patch(`/sizes/${id}`),
      )
        .send({ orden: 50 })
        .expect(200);
      expect((updated.body as { orden: number }).orden).toBe(50);
    });

    it('GET lista ordenada por `orden`, no alfabéticamente', async () => {
      const s = await owned(request(app.getHttpServer()).post('/sizes'))
        .send({ nombre: 'AAA-orden-bajo', orden: -100 })
        .expect(201);
      createdSizeIds.push((s.body as { id: number }).id);

      const response = await owned(
        request(app.getHttpServer()).get('/sizes'),
      ).expect(200);
      const body = response.body as { nombre: string; orden: number }[];
      const ordenes = body.map((x) => x.orden);
      expect(ordenes).toEqual([...ordenes].sort((a, b) => a - b));
      expect(body[0].nombre).toBe('AAA-orden-bajo');
    });
  });
});
