import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

describe('Auth (integration)', () => {
  let app: INestApplication<App>;
  let activeUserId: number;
  let inactiveUserId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const passwordHash = await argon2.hash('correct-password123');

    const active = await prisma.user.create({
      data: {
        email: 'auth-test-active@manitas.local',
        passwordHash,
        nombre: 'Activo',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    activeUserId = active.id;

    const inactive = await prisma.user.create({
      data: {
        email: 'auth-test-inactive@manitas.local',
        passwordHash,
        nombre: 'Inactivo',
        rol: UserRole.SELLER,
        activo: false,
      },
    });
    inactiveUserId = inactive.id;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { id: { in: [activeUserId, inactiveUserId] } },
    });
    await app.close();
    await prisma.$disconnect();
  });

  it('POST /auth/login con credenciales correctas devuelve 200, el usuario sin hash, y setea la cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'auth-test-active@manitas.local',
        password: 'correct-password123',
      })
      .expect(200);

    expect(response.body).toMatchObject({
      id: activeUserId,
      email: 'auth-test-active@manitas.local',
      nombre: 'Activo',
      rol: 'SELLER',
    });
    expect(
      (response.body as { passwordHash?: string }).passwordHash,
    ).toBeUndefined();

    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = (setCookie as unknown as string[]).join(';');
    expect(cookieHeader).toContain('access_token=');
    expect(cookieHeader).toContain('HttpOnly');
  });

  it('POST /auth/login con contraseña incorrecta da 401 genérico', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'auth-test-active@manitas.local',
        password: 'wrong-password',
      })
      .expect(401);

    expect((response.body as { message: string }).message).toBe(
      'Email o contraseña incorrectos',
    );
  });

  it('POST /auth/login con email inexistente da el mismo 401 genérico', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'no-existe@manitas.local', password: 'cualquier-cosa123' })
      .expect(401);

    expect((response.body as { message: string }).message).toBe(
      'Email o contraseña incorrectos',
    );
  });

  it('POST /auth/login de un usuario inactivo da el mismo 401 genérico (no revela que existe)', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'auth-test-inactive@manitas.local',
        password: 'correct-password123',
      })
      .expect(401);

    expect((response.body as { message: string }).message).toBe(
      'Email o contraseña incorrectos',
    );
  });

  it('POST /auth/login rechaza un body inválido (falta password)', async () => {
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'auth-test-active@manitas.local' })
      .expect(400);
  });

  it('GET /auth/me devuelve el usuario logueado', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        email: 'auth-test-active@manitas.local',
        password: 'correct-password123',
      })
      .expect(200);
    const cookie = (
      login.headers['set-cookie'] as unknown as string[]
    )[0].split(';')[0];

    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Cookie', cookie)
      .expect(200);

    expect(response.body).toMatchObject({
      id: activeUserId,
      email: 'auth-test-active@manitas.local',
      nombre: 'Activo',
      rol: 'SELLER',
    });
    expect(
      (response.body as { passwordHash?: string }).passwordHash,
    ).toBeUndefined();
  });

  it('GET /auth/me sin cookie de sesión da 401', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('POST /auth/logout siempre da 200 y limpia la cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/logout')
      .expect(200);

    const setCookie = response.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = (setCookie as unknown as string[]).join(';');
    expect(cookieHeader).toContain('access_token=;');
  });
});
