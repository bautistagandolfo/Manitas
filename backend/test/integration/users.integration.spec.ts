import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, UserRole } from '@prisma/client';
import { AppModule } from '../../src/app.module';

const prisma = new PrismaClient();

interface UserResponseBody {
  id: number;
  email: string;
  nombre: string;
  rol: string;
  activo: boolean;
  passwordHash?: string;
}

describe('Users (integration)', () => {
  let app: INestApplication<App>;
  const createdUserIds: number[] = [];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('POST /users crea un usuario y nunca devuelve el hash de la contraseña', async () => {
    const response = await request(app.getHttpServer())
      .post('/users')
      .send({
        email: 'users-test-1@manitas.local',
        password: 'password123',
        nombre: 'Vendedor Uno',
        rol: 'SELLER',
      })
      .expect(201);
    const body = response.body as UserResponseBody;

    createdUserIds.push(body.id);

    expect(body).toMatchObject({
      email: 'users-test-1@manitas.local',
      nombre: 'Vendedor Uno',
      rol: 'SELLER',
      activo: true,
    });
    expect(body.passwordHash).toBeUndefined();
  });

  it('POST /users rechaza un email duplicado con 409', async () => {
    const first = await request(app.getHttpServer())
      .post('/users')
      .send({
        email: 'users-test-dup@manitas.local',
        password: 'password123',
        nombre: 'Dup',
        rol: 'SELLER',
      })
      .expect(201);
    createdUserIds.push((first.body as UserResponseBody).id);

    await request(app.getHttpServer())
      .post('/users')
      .send({
        email: 'users-test-dup@manitas.local',
        password: 'otraPassword1',
        nombre: 'Otro',
        rol: 'SELLER',
      })
      .expect(409);
  });

  it('POST /users rechaza un body inválido (email mal formado)', async () => {
    await request(app.getHttpServer())
      .post('/users')
      .send({
        email: 'no-es-un-email',
        password: 'password123',
        nombre: 'X',
        rol: 'SELLER',
      })
      .expect(400);
  });

  it('GET /users lista usuarios sin exponer el hash de contraseña', async () => {
    const response = await request(app.getHttpServer())
      .get('/users')
      .expect(200);
    const body = response.body as UserResponseBody[];

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const user of body) {
      expect(user.passwordHash).toBeUndefined();
    }
  });

  it('PATCH /users/:id actualiza campos y PATCH /users/:id/password cambia el hash', async () => {
    const created = await request(app.getHttpServer())
      .post('/users')
      .send({
        email: 'users-test-2@manitas.local',
        password: 'password123',
        nombre: 'Original',
        rol: 'SELLER',
      })
      .expect(201);
    const userId = (created.body as UserResponseBody).id;
    createdUserIds.push(userId);

    const updated = await request(app.getHttpServer())
      .patch(`/users/${userId}`)
      .send({ nombre: 'Actualizado' })
      .expect(200);
    expect((updated.body as UserResponseBody).nombre).toBe('Actualizado');

    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    await request(app.getHttpServer())
      .patch(`/users/${userId}/password`)
      .send({ password: 'nuevaPassword123' })
      .expect(200);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(after.passwordHash).not.toBe(before.passwordHash);
  });

  it('PATCH /users/:id sobre un id inexistente da 404', async () => {
    await request(app.getHttpServer())
      .patch('/users/999999')
      .send({ nombre: 'Nadie' })
      .expect(404);
  });

  it('PATCH /users/:id rechaza desactivar al único OWNER activo del sistema', async () => {
    // Aísla el escenario: desactiva temporalmente a cualquier otro OWNER
    // activo (incluido el que siembra prisma/seed.ts), deja un único OWNER
    // de prueba activo, e intenta desactivarlo. Restaura todo al final.
    const otherActiveOwners = await prisma.user.findMany({
      where: { rol: UserRole.OWNER, activo: true },
    });

    const soloOwner = await request(app.getHttpServer())
      .post('/users')
      .send({
        email: 'users-test-solo-owner@manitas.local',
        password: 'password123',
        nombre: 'Solo Owner',
        rol: 'OWNER',
      })
      .expect(201);
    const soloOwnerId = (soloOwner.body as UserResponseBody).id;
    createdUserIds.push(soloOwnerId);

    await prisma.user.updateMany({
      where: { id: { in: otherActiveOwners.map((o) => o.id) } },
      data: { activo: false },
    });

    try {
      await request(app.getHttpServer())
        .patch(`/users/${soloOwnerId}`)
        .send({ activo: false })
        .expect(409);
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: otherActiveOwners.map((o) => o.id) } },
        data: { activo: true },
      });
    }
  });
});
