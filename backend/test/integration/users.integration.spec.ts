import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { PrismaClient, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
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

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('Users (integration)', () => {
  let app: INestApplication<App>;
  let authCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];

  function authed(req: request.Test): request.Test {
    return req.set('Cookie', authCookie);
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
        email: 'users-test-auth-owner@manitas.local',
        passwordHash,
        nombre: 'Owner de prueba',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: 'users-test-auth-seller@manitas.local',
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
    authCookie = extractCookie(ownerLogin.headers['set-cookie']);

    const sellerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: seller.email, password: 'password123' })
      .expect(200);
    sellerCookie = extractCookie(sellerLogin.headers['set-cookie']);
  });

  afterAll(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  it('GET /users sin cookie de sesión da 401', async () => {
    await request(app.getHttpServer()).get('/users').expect(401);
  });

  it('GET /users con sesión de SELLER da 403', async () => {
    await request(app.getHttpServer())
      .get('/users')
      .set('Cookie', sellerCookie)
      .expect(403);
  });

  it('POST /users crea un usuario y nunca devuelve el hash de la contraseña', async () => {
    const response = await authed(request(app.getHttpServer()).post('/users'))
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
    const first = await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-dup@manitas.local',
        password: 'password123',
        nombre: 'Dup',
        rol: 'SELLER',
      })
      .expect(201);
    createdUserIds.push((first.body as UserResponseBody).id);

    await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-dup@manitas.local',
        password: 'otraPassword1',
        nombre: 'Otro',
        rol: 'SELLER',
      })
      .expect(409);
  });

  it('POST /users: dos altas simultáneas con el mismo email — una gana, la otra recibe 409 (no las dos 201)', async () => {
    const email = 'users-test-race@manitas.local';
    const payload = {
      email,
      password: 'password123',
      nombre: 'Carrera',
      rol: 'SELLER',
    };

    const [first, second] = await Promise.all([
      authed(request(app.getHttpServer()).post('/users')).send(payload),
      authed(request(app.getHttpServer()).post('/users')).send(payload),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 409]);

    const winner = first.status === 201 ? first : second;
    createdUserIds.push((winner.body as UserResponseBody).id);
  });

  // Ticket nuevo (post Release Candidate) — hallazgo real de esta sesión:
  // "no-es-un-email" (el fixture original de este caso, antes de la
  // relajación) ahora es un usuario VÁLIDO a propósito (decisión del
  // usuario, apartándose de BLUEPRINT §5.1 — ver login.dto.ts). Con la
  // aserción vieja (`.expect(400)`), la request igual se mandaba
  // entera de verdad, así que el 201 real dejaba un usuario huérfano
  // en la base cada vez que este test corría — reproducido en vivo: el
  // id 15447 quedó colgado antes de arreglar esto. Reemplazado por dos
  // casos que sí siguen siendo inválidos con el criterio nuevo
  // (`\S{2,254}`, sin espacios): vacío y con espacios.
  it('POST /users rechaza un usuario vacío', async () => {
    await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: '',
        password: 'password123',
        nombre: 'X',
        rol: 'SELLER',
      })
      .expect(400);
  });

  it('POST /users rechaza un usuario con espacios', async () => {
    await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'con espacios',
        password: 'password123',
        nombre: 'X',
        rol: 'SELLER',
      })
      .expect(400);
  });

  it('QA adversarial: rechaza un rol fuera del enum en vez de guardarlo tal cual', async () => {
    await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-bad-role@manitas.local',
        password: 'password123',
        nombre: 'X',
        rol: 'SUPERADMIN',
      })
      .expect(400);
  });

  it('QA adversarial: mass-assignment — un body con campos extra (passwordHash, activo, id) se rechaza entero, no se ignora en silencio', async () => {
    // whitelist+forbidNonWhitelisted en el ValidationPipe global tiene que
    // frenar esto: sin eso, alguien podría mandar passwordHash directo y
    // saltarse el hasheo, o forzar activo:false/un id arbitrario.
    await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-mass-assignment@manitas.local',
        password: 'password123',
        nombre: 'X',
        rol: 'SELLER',
        passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$fake$fake',
        activo: false,
        id: 999999,
      })
      .expect(400);
  });

  it('QA adversarial: PATCH /users/:id con un campo no permitido (passwordHash) se rechaza, no se aplica parcialmente', async () => {
    const created = await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-patch-mass-assignment@manitas.local',
        password: 'password123',
        nombre: 'X',
        rol: 'SELLER',
      })
      .expect(201);
    createdUserIds.push((created.body as UserResponseBody).id);

    await authed(
      request(app.getHttpServer()).patch(
        `/users/${(created.body as UserResponseBody).id}`,
      ),
    )
      .send({ nombre: 'Nombre nuevo', passwordHash: 'lo-que-sea' })
      .expect(400);
  });

  it('QA adversarial: nombre de largo extremo se rechaza, no se trunca en silencio', async () => {
    await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-long-name@manitas.local',
        password: 'password123',
        nombre: 'A'.repeat(500),
        rol: 'SELLER',
      })
      .expect(400);
  });

  it('QA adversarial: id no numérico en la URL da 400, no 500', async () => {
    await authed(request(app.getHttpServer()).patch('/users/no-es-un-id'))
      .send({ nombre: 'Nadie' })
      .expect(400);
  });

  it('remediación fase 10 (CSRF, hallazgo 1): POST /users con Content-Type urlencoded se rechaza con 415, ni siquiera llega a autenticación', async () => {
    // Antes del fix: un <form> HTML nativo (nunca puede mandar JSON, solo
    // urlencoded/multipart/text-plain) podía crear un usuario nuevo con la
    // cookie real de una víctima OWNER, sin que CORS lo bloqueara (CORS no
    // protege "simple requests" como un form submit). El 415 tiene que
    // llegar ANTES que cualquier chequeo de sesión/rol — por eso ni
    // siquiera se manda la cookie acá.
    //
    // Nota (Fase 04, T2.4): antes comparaba prisma.user.count() antes y
    // después — con Jest corriendo varios archivos de integración en
    // paralelo contra la misma base, cualquier otro archivo (por ejemplo
    // el beforeAll/afterAll de stock.integration.spec.ts) puede crear o
    // borrar un usuario propio en el medio, y el conteo global cambia sin
    // que este test haya fallado en lo que realmente prueba. Se cambia a
    // verificar puntualmente que ESE email no exista — no le importa qué
    // hagan los demás archivos.
    await request(app.getHttpServer())
      .post('/users')
      .type('form')
      .send({
        email: 'users-test-csrf@manitas.local',
        password: 'password123',
        nombre: 'CSRF',
        rol: 'OWNER',
      })
      .expect(415);

    const created = await prisma.user.findUnique({
      where: { email: 'users-test-csrf@manitas.local' },
    });
    expect(created).toBeNull();
  });

  it('GET /users lista usuarios sin exponer el hash de contraseña', async () => {
    const response = await authed(
      request(app.getHttpServer()).get('/users'),
    ).expect(200);
    const body = response.body as UserResponseBody[];

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    for (const user of body) {
      expect(user.passwordHash).toBeUndefined();
    }
  });

  it('PATCH /users/:id actualiza campos y PATCH /users/:id/password cambia el hash', async () => {
    const created = await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-2@manitas.local',
        password: 'password123',
        nombre: 'Original',
        rol: 'SELLER',
      })
      .expect(201);
    const userId = (created.body as UserResponseBody).id;
    createdUserIds.push(userId);

    const updated = await authed(
      request(app.getHttpServer()).patch(`/users/${userId}`),
    )
      .send({ nombre: 'Actualizado' })
      .expect(200);
    expect((updated.body as UserResponseBody).nombre).toBe('Actualizado');

    const before = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    await authed(
      request(app.getHttpServer()).patch(`/users/${userId}/password`),
    )
      .send({ password: 'nuevaPassword123' })
      .expect(200);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    expect(after.passwordHash).not.toBe(before.passwordHash);

    // La contraseña vieja deja de servir para loguearse (module spec,
    // sección 9): no alcanza con que el hash haya cambiado en la base.
    const email = (created.body as UserResponseBody).email;
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'nuevaPassword123' })
      .expect(200);
  });

  it('PATCH /users/:id sobre un id inexistente da 404', async () => {
    await authed(request(app.getHttpServer()).patch('/users/999999'))
      .send({ nombre: 'Nadie' })
      .expect(404);
  });

  it('PATCH /users/:id permite desactivar a un OWNER cuando hay otro OWNER activo', async () => {
    const extraOwner = await authed(request(app.getHttpServer()).post('/users'))
      .send({
        email: 'users-test-extra-owner@manitas.local',
        password: 'password123',
        nombre: 'Owner extra',
        rol: 'OWNER',
      })
      .expect(201);
    const extraOwnerId = (extraOwner.body as UserResponseBody).id;
    createdUserIds.push(extraOwnerId);

    const updated = await authed(
      request(app.getHttpServer()).patch(`/users/${extraOwnerId}`),
    )
      .send({ activo: false })
      .expect(200);
    expect((updated.body as UserResponseBody).activo).toBe(false);
  });

  it('PATCH /users/:id rechaza desactivar al único OWNER activo del sistema', async () => {
    // Aísla el escenario: desactiva temporalmente a cualquier otro OWNER
    // activo (incluidos el owner de prueba de este archivo y el que
    // siembra prisma/seed.ts), deja un único OWNER de prueba activo, e
    // intenta desactivarlo. Restaura todo al final.
    const otherActiveOwners = await prisma.user.findMany({
      where: { rol: UserRole.OWNER, activo: true },
    });

    const soloOwner = await authed(request(app.getHttpServer()).post('/users'))
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
      await authed(request(app.getHttpServer()).patch(`/users/${soloOwnerId}`))
        .send({ activo: false })
        .expect(409);
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: otherActiveOwners.map((o) => o.id) } },
        data: { activo: true },
      });
    }
  });

  it('QA adversarial: dos bajas concurrentes de los dos últimos OWNER activos nunca dejan el sistema en 0 OWNER activos', async () => {
    // Aísla exactamente dos OWNER activos, y dispara dos PATCH simultáneos,
    // cada uno desactivando a uno de los dos. Sin bloqueo de filas, un
    // count() bajo READ COMMITTED puede dejar que las dos transacciones
    // lean "queda 1 más" a la vez y las dos pasen — dejando 0 OWNER
    // activos, exactamente lo que la regla existe para evitar. Confirmado
    // reproducible 29/30 veces sin el fix (SELECT ... FOR UPDATE), 0/30
    // con el fix, en un script aislado directo contra Prisma. Acá se repite
    // varias veces porque a nivel HTTP una sola vez no siempre alcanza a
    // abrir la ventana (el overhead de Nest/Express ya introduce cierto
    // orden) — no correrlo una sola vez sería un falso negativo.
    const otherActiveOwners = await prisma.user.findMany({
      where: { rol: UserRole.OWNER, activo: true },
    });
    await prisma.user.updateMany({
      where: { id: { in: otherActiveOwners.map((o) => o.id) } },
      data: { activo: false },
    });

    try {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const ownerA = await authed(request(app.getHttpServer()).post('/users'))
          .send({
            email: `users-test-race-owner-a-${attempt}@manitas.local`,
            password: 'password123',
            nombre: 'Owner A',
            rol: 'OWNER',
          })
          .expect(201);
        const ownerB = await authed(request(app.getHttpServer()).post('/users'))
          .send({
            email: `users-test-race-owner-b-${attempt}@manitas.local`,
            password: 'password123',
            nombre: 'Owner B',
            rol: 'OWNER',
          })
          .expect(201);
        const ownerAId = (ownerA.body as UserResponseBody).id;
        const ownerBId = (ownerB.body as UserResponseBody).id;
        createdUserIds.push(ownerAId, ownerBId);

        const [resultA, resultB] = await Promise.all([
          authed(request(app.getHttpServer()).patch(`/users/${ownerAId}`)).send(
            { activo: false },
          ),
          authed(request(app.getHttpServer()).patch(`/users/${ownerBId}`)).send(
            { activo: false },
          ),
        ]);

        const statuses = [resultA.status, resultB.status].sort();
        // Una tiene que ganar (200) y la otra ser rechazada (409) — nunca
        // las dos 200, porque eso dejaría 0 OWNER activos.
        expect(statuses).toEqual([200, 409]);

        const activeOwnersAfter = await prisma.user.count({
          where: { rol: UserRole.OWNER, activo: true },
        });
        expect(activeOwnersAfter).toBe(1);

        // Desactiva a los dos (ganador incluido) antes de la próxima
        // vuelta: si reactivara al ganador, la cantidad de OWNER activos
        // crecería en cada iteración y diluiría la carrera de la siguiente.
        await prisma.user.updateMany({
          where: { id: { in: [ownerAId, ownerBId] } },
          data: { activo: false },
        });
      }
    } finally {
      await prisma.user.updateMany({
        where: { id: { in: otherActiveOwners.map((o) => o.id) } },
        data: { activo: true },
      });
    }
  });
});
