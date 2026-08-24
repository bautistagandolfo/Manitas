import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Prisma,
  PrismaClient,
  CashMovementTipo,
  CashMovementReferenciaTipo,
  CashRegisterSessionEstado,
  UserRole,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { CashRegisterService } from '../../src/modules/cash-registers/cash-register.service';
import { SettingsService } from '../../src/common/settings/settings.service';
import { SETTINGS_KEYS } from '../../src/common/settings/settings-keys';

// Fase 04a (T3.1 + T3.2) — tests de integración escritos ANTES de la
// implementación, contra Postgres real (nunca mockeado, BLUEPRINT §9.8,
// excepción "plata y stock/caja": tests primero).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` (T3.1, T3.2),
// `BLUEPRINT.md` (§3.6, §5.1, §5.5, invariantes 2/7/9/10, §7, §9.4, §9.7) y
// `docs/build-protocol/state/reports/modulo-cash-registers-spec.md`
// (RN-1 a RN-12, secciones 4.1, 4.2, 5, 6, 7, 9). No se miró ninguna
// implementación de `stock.service.ts`/`stock.controller.ts` ni de ningún
// otro módulo — solo la ESTRUCTURA MECÁNICA de `stock.integration.spec.ts` y
// `stock-entradas.integration.spec.ts` (helpers `owned()`/`sold()`,
// instanciación directa del servicio con el `tx` de una transacción propia
// del test, limpieza en `afterAll` con arrays de ids creados).
//
// `cash-register.service.ts` NO existe todavía (se crea en la Fase 04, otra
// sesión) — este archivo entero debe fallar al compilar por
// "Cannot find module" en el import de `CashRegisterService` de más arriba.
// Eso es la razón correcta de rojo para la Fase 04a, no un error a corregir.
//
// No hay controller/módulo de `cash-registers` registrado en `AppModule`
// todavía: las rutas HTTP de esta suite (`POST /cash-registers/sessions`)
// van a responder 404 hasta que exista, que es exactamente la ausencia que
// esta fase debe dejar documentada — no se modifica `app.module.ts` acá.

const prisma = new PrismaClient();
const settingsService = new SettingsService(prisma as unknown as PrismaService);
// Fase 04 (implementación, T3.4): CashRegisterService pasó a depender de
// SettingsService (RN-5, lee `umbral_diferencia_caja` real de T0.13) — el
// constructor ahora toma dos argumentos.
const service = new CashRegisterService(
  prisma as unknown as PrismaService,
  settingsService,
);

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('cash-registers (integration, T3.1 + T3.2)', () => {
  let app: INestApplication<App>;
  let ownerId: number;
  let sellerId: number;
  let ownerCookie: string;
  let sellerCookie: string;
  const createdUserIds: number[] = [];
  const createdSessionIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  // Cierra directamente por Prisma cualquier sesión que haya quedado
  // ABIERTA entre tests. Es necesario porque el índice único parcial
  // `cash_register_sessions_one_open_key` (ya en la base desde la fase 01)
  // bloquea cualquier apertura nueva mientras exista una ABIERTA, y varios
  // tests de este archivo necesitan arrancar desde "no hay sesión abierta".
  // `cerrarSesion` real todavía no existe (es de T3.4), así que el cierre
  // para dejar la base limpia se hace a mano, directo por Prisma — nunca
  // pasando por el servicio (que tampoco expone ese método todavía).
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

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: `cash-registers-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (caja)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `cash-registers-test-seller-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Seller de prueba (caja)',
        rol: UserRole.SELLER,
        activo: true,
      },
    });
    sellerId = seller.id;
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

  afterEach(async () => {
    await closeAnyOpenSessionDirect();
  });

  afterAll(async () => {
    // Fase 04 (implementación) — hallazgo de tooling, no de negocio: el
    // trigger `cash_movements_immutable_after_close` (RN-8, agregado en
    // esta fase) bloquea CUALQUIER escritura sobre `cash_movements` de una
    // sesión CERRADA, incluido el DELETE de limpieza — varios tests de
    // este archivo cierran sesiones a propósito. Reabrir cada sesión antes
    // de borrar sus movimientos (update directo sobre
    // `cash_register_sessions`, que el trigger no toca) es la limpieza
    // correcta: no desactiva la protección real, solo evita que la
    // limpieza de datos de prueba choque contra el mismo invariante que el
    // archivo está probando. Una sesión por vez, y se borra por completo
    // antes de reabrir la siguiente — el índice único parcial de sesión
    // ABIERTA (RN-1) no tolera dos al mismo tiempo. `Set` porque el mismo
    // id puede haber quedado dos veces en el array (la propia prueba lo
    // agrega al crearlo, y `closeAnyOpenSessionDirect` lo vuelve a agregar
    // si lo encuentra abierto en el `afterEach` siguiente).
    for (const id of new Set(createdSessionIds)) {
      await prisma.cashRegisterSession.update({
        where: { id },
        data: { estado: CashRegisterSessionEstado.ABIERTA },
      });
      await prisma.cashMovement.deleteMany({ where: { sessionId: id } });
      await prisma.cashRegisterSession.delete({ where: { id } });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
    await app.close();
    await prisma.$disconnect();
  });

  describe('POST /cash-registers/sessions (T3.1, RN-1, invariante 9)', () => {
    it('OWNER: 201 con montoInicial válido, sesión creada en estado ABIERTA', async () => {
      const response = await owned(
        request(app.getHttpServer()).post('/cash-registers/sessions'),
      )
        .send({ montoInicial: '1000.00' })
        .expect(201);

      const body = response.body as { id: number; estado: string };
      createdSessionIds.push(body.id);
      expect(body.estado).toBe(CashRegisterSessionEstado.ABIERTA);
    });

    it('SELLER: 201 con montoInicial válido (RN-2, §5.5: tiene que poder abrir sola)', async () => {
      const response = await sold(
        request(app.getHttpServer()).post('/cash-registers/sessions'),
      )
        .send({ montoInicial: '0.00' })
        .expect(201);

      const body = response.body as { id: number; estado: string };
      createdSessionIds.push(body.id);
      expect(body.estado).toBe(CashRegisterSessionEstado.ABIERTA);
    });

    it('400 con montoInicial negativo', async () => {
      await owned(request(app.getHttpServer()).post('/cash-registers/sessions'))
        .send({ montoInicial: '-1.00' })
        .expect(400);
    });

    it('409 si ya hay una sesión ABIERTA — dispara la constraint única real de la base (RN-1)', async () => {
      const first = await owned(
        request(app.getHttpServer()).post('/cash-registers/sessions'),
      )
        .send({ montoInicial: '200.00' })
        .expect(201);
      const firstBody = first.body as { id: number };
      createdSessionIds.push(firstBody.id);

      await sold(request(app.getHttpServer()).post('/cash-registers/sessions'))
        .send({ montoInicial: '50.00' })
        .expect(409);
    });
  });

  describe('registrarMovimiento — signo real en Postgres (T3.2, RN-3)', () => {
    async function abrirSesionDeTest(userId: number): Promise<number> {
      const session = await prisma.$transaction((tx) =>
        service.abrirSesion(tx, {
          montoInicial: new Prisma.Decimal('300.00'),
          userId,
        }),
      );
      createdSessionIds.push(session.id);
      return session.id;
    }

    it('un movimiento VENTA queda insertado con monto positivo', async () => {
      const sessionId = await abrirSesionDeTest(ownerId);

      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.VENTA,
          monto: new Prisma.Decimal('150.00'),
          referenciaTipo: CashMovementReferenciaTipo.SALE,
          referenciaId: 1,
          descripcion: 'Venta de prueba',
          userId: ownerId,
        }),
      );

      const movement = await prisma.cashMovement.findFirst({
        where: { sessionId, tipo: CashMovementTipo.VENTA },
      });
      expect(movement?.monto.toString()).toBe('150');
    });

    it('un movimiento RETIRO queda insertado con monto negativo', async () => {
      const sessionId = await abrirSesionDeTest(ownerId);

      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.RETIRO,
          monto: new Prisma.Decimal('80.00'),
          descripcion: 'Retiro de prueba',
          userId: ownerId,
        }),
      );

      const movement = await prisma.cashMovement.findFirst({
        where: { sessionId, tipo: CashMovementTipo.RETIRO },
      });
      expect(movement?.monto.toString()).toBe('-80');
    });

    it('el CHECK real de la base rechaza un signo incorrecto insertado directo por Prisma, sorteando el servicio (defensa en profundidad, §3.6)', async () => {
      const sessionId = await abrirSesionDeTest(ownerId);

      // VENTA debe ser siempre positivo (RN-3) — acá se manda a propósito
      // con signo negativo, sin pasar por `registrarMovimiento`, para
      // confirmar que el CHECK de la base ya lo rechaza por su cuenta.
      await expect(
        prisma.cashMovement.create({
          data: {
            sessionId,
            fecha: new Date(),
            tipo: CashMovementTipo.VENTA,
            monto: new Prisma.Decimal('-150.00'),
            descripcion: 'Inserción directa con signo inválido',
            userId: ownerId,
          },
        }),
      ).rejects.toThrow();

      const count = await prisma.cashMovement.count({ where: { sessionId } });
      expect(count).toBe(0);
    });

    it('rechaza registrar un movimiento contra una sesión CERRADA sin insertar nada (RN-8, inmutabilidad tras el cierre)', async () => {
      // `cerrarSesion` todavía no existe (T3.4): la sesión CERRADA para este
      // test se crea directo por Prisma, ya en ese estado.
      const cerrada = await prisma.cashRegisterSession.create({
        data: {
          fechaApertura: new Date(),
          userIdApertura: ownerId,
          montoInicial: new Prisma.Decimal('100.00'),
          estado: CashRegisterSessionEstado.CERRADA,
          fechaCierre: new Date(),
          userIdCierre: ownerId,
          montoDeclarado: new Prisma.Decimal('100.00'),
          montoSistema: new Prisma.Decimal('100.00'),
          diferencia: new Prisma.Decimal('0.00'),
        },
      });
      createdSessionIds.push(cerrada.id);

      await expect(
        prisma.$transaction((tx) =>
          service.registrarMovimiento(tx, {
            sessionId: cerrada.id,
            tipo: CashMovementTipo.VENTA,
            monto: new Prisma.Decimal('50.00'),
            descripcion: 'Venta contra sesión cerrada',
            userId: ownerId,
          }),
        ),
      ).rejects.toThrow(/cerrada/i);

      const count = await prisma.cashMovement.count({
        where: { sessionId: cerrada.id },
      });
      expect(count).toBe(0);
    });

    // Cobertura agregada en la Fase 04 (implementación), no de la Fase 04a:
    // RN-8 pide que la inmutabilidad tras el cierre se refuerce "a nivel de
    // base de datos" (BLUEPRINT §5.5, literal) — hasta este ticket esa
    // protección solo existía en CashRegisterService.registrarMovimiento
    // (probado arriba). Este caso confirma el trigger de la migración
    // `20260824181450_cash_movements_immutable_after_close` de forma
    // independiente, insertando directo por Prisma y sorteando el servicio
    // por completo — mismo criterio que el test del CHECK de signo de más
    // arriba (defensa en profundidad real, no solo a nivel de aplicación).
    it('el trigger de la base rechaza un INSERT directo contra una sesión CERRADA, sorteando el servicio (RN-8, defensa en profundidad)', async () => {
      const cerrada = await prisma.cashRegisterSession.create({
        data: {
          fechaApertura: new Date(),
          userIdApertura: ownerId,
          montoInicial: new Prisma.Decimal('100.00'),
          estado: CashRegisterSessionEstado.CERRADA,
          fechaCierre: new Date(),
          userIdCierre: ownerId,
          montoDeclarado: new Prisma.Decimal('100.00'),
          montoSistema: new Prisma.Decimal('100.00'),
          diferencia: new Prisma.Decimal('0.00'),
        },
      });
      createdSessionIds.push(cerrada.id);

      await expect(
        prisma.cashMovement.create({
          data: {
            sessionId: cerrada.id,
            fecha: new Date(),
            tipo: CashMovementTipo.INGRESO_MANUAL,
            monto: new Prisma.Decimal('20.00'),
            descripcion: 'Inserción directa contra sesión cerrada',
            userId: ownerId,
          },
        }),
      ).rejects.toThrow();

      const count = await prisma.cashMovement.count({
        where: { sessionId: cerrada.id },
      });
      expect(count).toBe(0);
    });
  });

  describe('getSesionAbiertaOrThrow (T3.2, RN-10, invariante 9)', () => {
    it('devuelve la sesión ABIERTA real cuando existe', async () => {
      const session = await prisma.$transaction((tx) =>
        service.abrirSesion(tx, {
          montoInicial: new Prisma.Decimal('400.00'),
          userId: sellerId,
        }),
      );
      createdSessionIds.push(session.id);

      const result = await prisma.$transaction((tx) =>
        service.getSesionAbiertaOrThrow(tx),
      );
      expect(result.id).toBe(session.id);
      expect(result.estado).toBe(CashRegisterSessionEstado.ABIERTA);
    });

    it('lanza si no hay ninguna sesión ABIERTA', async () => {
      // Cierra explícitamente antes del caso, además de la limpieza
      // automática de `afterEach` — el enunciado pide dejar este cierre
      // explícito para que el test sea legible por sí solo.
      await closeAnyOpenSessionDirect();

      await expect(
        prisma.$transaction((tx) => service.getSesionAbiertaOrThrow(tx)),
      ).rejects.toThrow(/sesi[oó]n.*abiert/i);
    });
  });

  // Fase 04a (T3.3) — `POST /cash-registers/movements/ingreso` y `/retiro`
  // TODAVÍA NO EXISTEN (`CashRegistersController` hoy solo tiene
  // `POST /sessions`, regla explícita de esta fase: no se edita el
  // controller acá) — toda request contra esas rutas debe responder 404
  // hasta la Fase 04. Es la razón correcta de rojo para los tests de abajo;
  // no se agrega ningún stub de ruta para forzar otro status.
  //
  // RN-12/§9.7 (BLUEPRINT, ejemplo textual: "un doble click en un retiro de
  // $50.000... el arqueo muestra un faltante fantasma") es el caso más
  // importante de este ticket — se confirma contando filas reales en
  // `cash_movements`, nunca solo mirando el status HTTP de la respuesta.
  async function abrirSesionParaMovimientoManual(
    userId: number,
  ): Promise<number> {
    const session = await prisma.$transaction((tx) =>
      service.abrirSesion(tx, {
        montoInicial: new Prisma.Decimal('300.00'),
        userId,
      }),
    );
    createdSessionIds.push(session.id);
    return session.id;
  }

  describe('POST /cash-registers/movements/ingreso (T3.3, RN-12, AMB-13)', () => {
    it('OWNER con Idempotency-Key real, monto/descripcion válidos → 201, el movimiento queda en la base con tipo INGRESO_MANUAL y signo positivo', async () => {
      await abrirSesionParaMovimientoManual(ownerId);
      const key = randomUUID();

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', key)
        .send({ monto: '500.00', descripcion: 'Ingreso manual de prueba' })
        .expect(201);

      const movement = await prisma.cashMovement.findUnique({
        where: { idempotencyKey: key },
      });
      expect(movement).not.toBeNull();
      expect(movement?.tipo).toBe(CashMovementTipo.INGRESO_MANUAL);
      expect(movement?.monto.toString()).toBe('500');
    });

    it('SELLER: 403 (AMB-13, RESUELTA — OWNER-only)', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      await sold(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Intento de SELLER' })
        .expect(403);
    });

    it('sin header Idempotency-Key → 400', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .send({ monto: '100.00', descripcion: 'Sin header' })
        .expect(400);
    });

    it('doble click: la misma request (mismo Idempotency-Key) mandada dos veces seguidas responde 201/200 con el mismo resultado, pero queda UNA sola fila en cash_movements (BLUEPRINT §9.7, ejemplo textual)', async () => {
      await abrirSesionParaMovimientoManual(ownerId);
      const key = randomUUID();
      const body = { monto: '250.00', descripcion: 'Doble click en ingreso' };

      const first = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(first.status);

      const second = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(second.status);

      const firstBody = first.body as { id: number };
      const secondBody = second.body as { id: number };
      expect(secondBody.id).toBe(firstBody.id);

      const count = await prisma.cashMovement.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });

    it('dos requests con Idempotency-Key DISTINTAS → dos filas distintas (la protección es por clave, no un bloqueo general)', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      const first = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Primer ingreso' })
        .expect(201);

      const second = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Segundo ingreso' })
        .expect(201);

      const firstBody = first.body as { id: number };
      const secondBody = second.body as { id: number };
      expect(firstBody.id).not.toBe(secondBody.id);
    });

    it('sin sesión de caja abierta → 409', async () => {
      await closeAnyOpenSessionDirect();

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Sin sesión abierta' })
        .expect(409);
    });

    it('monto <= 0 → 400', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/ingreso'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '0.00', descripcion: 'Monto inválido' })
        .expect(400);
    });
  });

  describe('POST /cash-registers/movements/retiro (T3.3, RN-12, AMB-13) — mismos casos que ingreso, signo negativo', () => {
    it('OWNER con Idempotency-Key real, monto/descripcion válidos → 201, el movimiento queda en la base con tipo RETIRO y signo negativo', async () => {
      await abrirSesionParaMovimientoManual(ownerId);
      const key = randomUUID();

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', key)
        .send({ monto: '500.00', descripcion: 'Retiro manual de prueba' })
        .expect(201);

      const movement = await prisma.cashMovement.findUnique({
        where: { idempotencyKey: key },
      });
      expect(movement).not.toBeNull();
      expect(movement?.tipo).toBe(CashMovementTipo.RETIRO);
      expect(movement?.monto.toString()).toBe('-500');
    });

    it('SELLER: 403 (AMB-13, RESUELTA — OWNER-only)', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      await sold(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Intento de SELLER' })
        .expect(403);
    });

    it('sin header Idempotency-Key → 400', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .send({ monto: '100.00', descripcion: 'Sin header' })
        .expect(400);
    });

    it('doble click: la misma request (mismo Idempotency-Key) mandada dos veces seguidas responde 201/200 con el mismo resultado, pero queda UNA sola fila en cash_movements (BLUEPRINT §9.7, ejemplo textual — retiro)', async () => {
      await abrirSesionParaMovimientoManual(ownerId);
      const key = randomUUID();
      const body = { monto: '250.00', descripcion: 'Doble click en retiro' };

      const first = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(first.status);

      const second = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(second.status);

      const firstBody = first.body as { id: number };
      const secondBody = second.body as { id: number };
      expect(secondBody.id).toBe(firstBody.id);

      const count = await prisma.cashMovement.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });

    it('dos requests con Idempotency-Key DISTINTAS → dos filas distintas (la protección es por clave, no un bloqueo general)', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      const first = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Primer retiro' })
        .expect(201);

      const second = await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Segundo retiro' })
        .expect(201);

      const firstBody = first.body as { id: number };
      const secondBody = second.body as { id: number };
      expect(firstBody.id).not.toBe(secondBody.id);
    });

    it('sin sesión de caja abierta → 409', async () => {
      await closeAnyOpenSessionDirect();

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '100.00', descripcion: 'Sin sesión abierta' })
        .expect(409);
    });

    it('monto <= 0 → 400', async () => {
      await abrirSesionParaMovimientoManual(ownerId);

      await owned(
        request(app.getHttpServer()).post('/cash-registers/movements/retiro'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({ monto: '0.00', descripcion: 'Monto inválido' })
        .expect(400);
    });
  });

  // Fase 04a (T3.4) — `POST /cash-registers/sessions/:id/close` TODAVÍA NO
  // EXISTE (`CashRegistersController` hoy solo tiene `POST /sessions` y las
  // dos rutas de movimiento manual de T3.3, regla explícita de esta fase:
  // no se edita el controller acá) — toda request contra esta ruta debe
  // responder 404 hasta la Fase 04. Es la razón correcta de rojo para casi
  // todos los tests de abajo.
  //
  // **Caveat señalado, no corregido**: el caso "cerrar una sesión
  // inexistente → 404" de más abajo va a devolver 404 incluso HOY, pero por
  // el motivo equivocado (ruta inexistente, no "sesión no encontrada") — es
  // un solape inevitable entre "la ruta no existe" y "la ruta existe pero
  // la sesión no", ambos 404. Se deja igual porque es la aserción correcta
  // una vez que la Fase 04 implemente la ruta real; no demuestra rojo por
  // sí solo en esta fase, a diferencia del resto de los casos de este
  // bloque.
  //
  // El umbral se lee del `SettingsService` real (sembrado por T0.13,
  // AMB-10 RESUELTA en $500) en vez de hardcodearlo como número mágico —
  // los comentarios de cada test igual mencionan "$500" porque es el valor
  // real esperado hoy, para que el test se lea sin tener que ir a buscar el
  // seed.
  describe('POST /cash-registers/sessions/:id/close (T3.4, RN-4, RN-5, RN-6, invariante 2)', () => {
    let umbralDiferenciaCaja: Prisma.Decimal;

    beforeAll(async () => {
      umbralDiferenciaCaja = await settingsService.getDecimal(
        SETTINGS_KEYS.UMBRAL_DIFERENCIA_CAJA,
      );
    });

    async function abrirSesionParaCierre(
      userId: number,
      montoInicial: string,
    ): Promise<number> {
      const session = await prisma.$transaction((tx) =>
        service.abrirSesion(tx, {
          montoInicial: new Prisma.Decimal(montoInicial),
          userId,
        }),
      );
      createdSessionIds.push(session.id);
      return session.id;
    }

    it('OWNER cierra con movimientos reales: 200, la sesión queda CERRADA en la base con montoSistema/diferencia correctos, y la respuesta HTTP los incluye', async () => {
      const sessionId = await abrirSesionParaCierre(ownerId, '100.00');
      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.VENTA,
          monto: new Prisma.Decimal('400.00'),
          descripcion: 'Venta real para el arqueo',
          userId: ownerId,
        }),
      );
      // montoSistema esperado = 100 (inicial) + 400 (venta) = 500

      const response = await owned(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({ montoDeclarado: '500.00' })
        .expect(200);

      const body = response.body as {
        estado: string;
        montoSistema: string;
        diferencia: string;
      };
      expect(body.estado).toBe(CashRegisterSessionEstado.CERRADA);
      expect(new Prisma.Decimal(body.montoSistema).toString()).toBe('500');
      expect(new Prisma.Decimal(body.diferencia).toString()).toBe('0');

      const stored = await prisma.cashRegisterSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(stored.estado).toBe(CashRegisterSessionEstado.CERRADA);
      expect(stored.montoSistema?.toString()).toBe('500');
      expect(stored.diferencia?.toString()).toBe('0');
    });

    it('SELLER cierra: 200, la respuesta HTTP NO incluye montoSistema ni diferencia (RN-6, cierre a ciegas)', async () => {
      const sessionId = await abrirSesionParaCierre(sellerId, '100.00');
      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.VENTA,
          monto: new Prisma.Decimal('400.00'),
          descripcion: 'Venta real para el arqueo (SELLER)',
          userId: sellerId,
        }),
      );

      const response = await sold(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({ montoDeclarado: '500.00' })
        .expect(200);

      const body = response.body as Record<string, unknown>;
      expect(body.estado).toBe(CashRegisterSessionEstado.CERRADA);
      expect(body.montoSistema).toBeUndefined();
      expect(body.diferencia).toBeUndefined();
    });

    it('diferencia real >= umbral_diferencia_caja (config real T0.13, hoy $500) cerrando OWNER SIN notaCierre → 400', async () => {
      const sessionId = await abrirSesionParaCierre(ownerId, '0.00');
      // Sin movimientos: montoSistema = 0. Declarar exactamente el umbral
      // como faltante dispara RN-5 (>=, no >).

      await owned(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({ montoDeclarado: umbralDiferenciaCaja.toString() })
        .expect(400);
    });

    it('diferencia real >= umbral_diferencia_caja cerrando OWNER CON notaCierre → 200, la nota queda guardada', async () => {
      const sessionId = await abrirSesionParaCierre(ownerId, '0.00');
      const nota =
        'Faltante grande: se cuenta que el POS se trabó a mitad de turno.';

      const response = await owned(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({
          montoDeclarado: umbralDiferenciaCaja.toString(),
          notaCierre: nota,
        })
        .expect(200);

      const body = response.body as { estado: string };
      expect(body.estado).toBe(CashRegisterSessionEstado.CERRADA);

      const stored = await prisma.cashRegisterSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(stored.notaCierre).toBe(nota);
    });

    it('diferencia real >= umbral_diferencia_caja cerrando SELLER SIN nota → 200 (RN-6, nunca se le exige)', async () => {
      const sessionId = await abrirSesionParaCierre(sellerId, '0.00');

      await sold(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({ montoDeclarado: umbralDiferenciaCaja.toString() })
        .expect(200);
    });

    it('cerrar una sesión que ya está CERRADA → rechazada (409, mismo patrón de errores que el resto del módulo)', async () => {
      const sessionId = await abrirSesionParaCierre(ownerId, '100.00');
      await owned(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({ montoDeclarado: '100.00' })
        .expect(200);

      await owned(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({ montoDeclarado: '100.00' })
        .expect(409);
    });

    it('cerrar una sesión inexistente → 404', async () => {
      await owned(
        request(app.getHttpServer()).post(
          '/cash-registers/sessions/999999999/close',
        ),
      )
        .send({ montoDeclarado: '100.00' })
        .expect(404);
    });

    // Caso opcional del enunciado (ya cubierto en espíritu por los tests de
    // RN-8 más arriba, pero encadenado explícitamente con el flujo HTTP de
    // este ticket): una vez cerrada por esta ruta nueva, un movimiento
    // nuevo contra esa sesión sigue rechazado por la misma protección de
    // T3.1/T3.2 (aplicación) + el trigger de la migración (base).
    it('después de cerrar vía HTTP, un movimiento nuevo contra esa sesión es rechazado (RN-8, encadenado con este flujo)', async () => {
      const sessionId = await abrirSesionParaCierre(ownerId, '100.00');
      await owned(
        request(app.getHttpServer()).post(
          `/cash-registers/sessions/${sessionId}/close`,
        ),
      )
        .send({ montoDeclarado: '100.00' })
        .expect(200);

      await expect(
        prisma.$transaction((tx) =>
          service.registrarMovimiento(tx, {
            sessionId,
            tipo: CashMovementTipo.VENTA,
            monto: new Prisma.Decimal('50.00'),
            descripcion: 'Venta contra sesión recién cerrada por HTTP',
            userId: ownerId,
          }),
        ),
      ).rejects.toThrow(/cerrada/i);
    });
  });

  // Fase 04a (T3.5) — `GET /cash-registers/sessions/open` TODAVÍA NO EXISTE
  // (`CashRegistersController` hoy solo tiene `POST /sessions`,
  // `POST /movements/ingreso`, `POST /movements/retiro` y
  // `POST /sessions/:id/close`, regla explícita de esta fase: no se edita
  // el controller acá) — toda request contra esta ruta responde 404 hasta
  // la Fase 04.
  //
  // RN-7 (spec del módulo, sección 2): no hay una regla de "detección"
  // activa aparte de este endpoint — como solo puede existir una sesión
  // ABIERTA a la vez (RN-1), alcanza con exponer la sesión ABIERTA actual
  // (con su `fechaApertura`) para que el frontend (T3.7) la compare contra
  // "hoy" en hora argentina y decida si mostrarla como "sesión olvidada".
  // Este ticket no implementa esa comparación, solo el dato.
  //
  // **Mismo caveat que la fase 04a de T3.4** con "sesión inexistente": el
  // caso "sin ninguna sesión ABIERTA → 404" de más abajo también da 404
  // HOY, pero por el motivo equivocado (ruta inexistente, no "no hay
  // sesión abierta") — solape inevitable entre ambos 404, documentado acá
  // en vez de "resuelto": es la aserción correcta una vez que la Fase 04
  // implemente la ruta real, no una demostración de rojo por sí sola en
  // esta fase (a diferencia del resto de los casos de este bloque, que sí
  // están hoy en rojo por la ausencia real de la ruta).
  describe('GET /cash-registers/sessions/open (T3.5, RN-7, invariante 2)', () => {
    async function abrirSesionParaOpen(
      userId: number,
      montoInicial: string,
    ): Promise<number> {
      const session = await prisma.$transaction((tx) =>
        service.abrirSesion(tx, {
          montoInicial: new Prisma.Decimal(montoInicial),
          userId,
        }),
      );
      createdSessionIds.push(session.id);
      return session.id;
    }

    it('OWNER: 200 con la sesión ABIERTA actual, montoSistema recalculado correctamente (montoInicial + SUM(movimientos))', async () => {
      const sessionId = await abrirSesionParaOpen(ownerId, '100.00');
      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.VENTA,
          monto: new Prisma.Decimal('400.00'),
          descripcion: 'Venta real para el cálculo en vivo',
          userId: ownerId,
        }),
      );
      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.RETIRO,
          monto: new Prisma.Decimal('50.00'),
          descripcion: 'Retiro real para el cálculo en vivo',
          userId: ownerId,
        }),
      );
      // montoSistema esperado = 100 (inicial) + 400 (venta) - 50 (retiro) = 450

      const response = await owned(
        request(app.getHttpServer()).get('/cash-registers/sessions/open'),
      ).expect(200);

      const body = response.body as {
        id: number;
        estado: string;
        montoSistema: string;
      };
      expect(body.id).toBe(sessionId);
      expect(body.estado).toBe(CashRegisterSessionEstado.ABIERTA);
      expect(new Prisma.Decimal(body.montoSistema).toString()).toBe('450');
    });

    it('SELLER: 200 pero la respuesta NO incluye montoSistema (RN-6, cierre a ciegas aplicado también acá)', async () => {
      await abrirSesionParaOpen(sellerId, '100.00');

      const response = await sold(
        request(app.getHttpServer()).get('/cash-registers/sessions/open'),
      ).expect(200);

      const body = response.body as Record<string, unknown>;
      expect(body.estado).toBe(CashRegisterSessionEstado.ABIERTA);
      expect(body.montoSistema).toBeUndefined();
    });

    it('sin ninguna sesión ABIERTA → 404', async () => {
      await closeAnyOpenSessionDirect();

      await owned(
        request(app.getHttpServer()).get('/cash-registers/sessions/open'),
      ).expect(404);
    });

    it('la respuesta incluye fechaApertura (necesario para T3.7: comparar contra "hoy" en hora argentina y decidir si es una sesión olvidada)', async () => {
      const sessionId = await abrirSesionParaOpen(ownerId, '0.00');

      const response = await owned(
        request(app.getHttpServer()).get('/cash-registers/sessions/open'),
      ).expect(200);

      const body = response.body as { id: number; fechaApertura: string };
      expect(body.id).toBe(sessionId);
      expect(body.fechaApertura).toBeTruthy();
      expect(new Date(body.fechaApertura).toString()).not.toBe('Invalid Date');
    });

    it('el montoSistema de una sesión todavía ABIERTA es el mismo que calcularía un cierre real en ese momento (invariante 2, "recalculable en cualquier momento, también con la sesión abierta")', async () => {
      const sessionId = await abrirSesionParaOpen(ownerId, '250.00');
      const movimientos = [
        { tipo: CashMovementTipo.VENTA, monto: '300.00' },
        { tipo: CashMovementTipo.INGRESO_MANUAL, monto: '75.00' },
        { tipo: CashMovementTipo.RETIRO, monto: '120.00' },
        { tipo: CashMovementTipo.GASTO, monto: '20.00' },
      ] as const;
      for (const m of movimientos) {
        await prisma.$transaction((tx) =>
          service.registrarMovimiento(tx, {
            sessionId,
            tipo: m.tipo,
            monto: new Prisma.Decimal(m.monto),
            descripcion: `Movimiento ${m.tipo} para verificación de invariante 2`,
            userId: ownerId,
          }),
        );
      }
      // Suma manual de los signos reales aplicados por el servicio (RN-3):
      // VENTA/INGRESO_MANUAL positivos, RETIRO/GASTO negativos.
      // 250 + 300 + 75 - 120 - 20 = 485
      const sumaManual = new Prisma.Decimal('250.00')
        .plus('300.00')
        .plus('75.00')
        .minus('120.00')
        .minus('20.00');

      const response = await owned(
        request(app.getHttpServer()).get('/cash-registers/sessions/open'),
      ).expect(200);

      const body = response.body as { montoSistema: string };
      expect(new Prisma.Decimal(body.montoSistema).toString()).toBe(
        sumaManual.toString(),
      );
    });
  });

  // Fase 04a (T3.6) — `reconciliar` TODAVÍA NO EXISTE en
  // `CashRegisterService` (se agrega recién en la Fase 04, otra sesión) —
  // regla explícita de esta fase: no se edita `cash-register.service.ts`.
  // Toda llamada de abajo debe lanzar `TypeError: ... is not a function`
  // en runtime; es la razón correcta de rojo para estos dos casos, no un
  // error de compilación (`service` real ya expone `abrirSesion`/
  // `registrarMovimiento`/`cerrarSesion`, todos VERDE desde T3.1-T3.4 — se
  // usan tal cual para armar el escenario real contra Postgres).
  //
  // `reconciliar()` no recibe ningún `tx` (spec §4.2, contrato sugerido en
  // el ticket): abre su propia transacción de solo lectura — mismo patrón
  // documentado en prosa en `state/STATUS.md` (fila de T2.8) para
  // `stock.service.reconciliar()`. Por eso se llama directo sobre
  // `service`, sin envolver en `prisma.$transaction(...)` como el resto de
  // los métodos de este archivo.
  describe('reconciliar (T3.6, invariante 2)', () => {
    interface CashRegisterReconciliationMismatch {
      sessionId: number;
      montoSistemaGuardado: Prisma.Decimal;
      montoSistemaRecalculado: Prisma.Decimal;
    }

    interface CashRegisterServiceWithReconciliar {
      reconciliar(): Promise<CashRegisterReconciliationMismatch[]>;
    }

    function withReconciliar(
      s: CashRegisterService,
    ): CashRegisterServiceWithReconciliar {
      return s;
    }

    async function abrirSesionParaReconciliar(
      userId: number,
      montoInicial: string,
    ): Promise<number> {
      const session = await prisma.$transaction((tx) =>
        service.abrirSesion(tx, {
          montoInicial: new Prisma.Decimal(montoInicial),
          userId,
        }),
      );
      createdSessionIds.push(session.id);
      return session.id;
    }

    it('sesión cerrada con movimientos reales de distintos tipos, cerrada vía cerrarSesion: reconciliar no la reporta (coincide)', async () => {
      const sessionId = await abrirSesionParaReconciliar(ownerId, '100.00');
      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.VENTA,
          monto: new Prisma.Decimal('400.00'),
          descripcion: 'Venta real para T3.6',
          userId: ownerId,
        }),
      );
      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.RETIRO,
          monto: new Prisma.Decimal('50.00'),
          descripcion: 'Retiro real para T3.6',
          userId: ownerId,
        }),
      );
      // montoSistema real = 100 (inicial) + 400 (venta) - 50 (retiro) = 450
      await prisma.$transaction((tx) =>
        service.cerrarSesion(tx, {
          sessionId,
          montoDeclarado: new Prisma.Decimal('450.00'),
          userId: ownerId,
          esOwner: true,
        }),
      );

      const mismatches = await withReconciliar(service).reconciliar();

      expect(mismatches.some((m) => m.sessionId === sessionId)).toBe(false);
    });

    it('una sesión cerrada cuyo montoSistema se altera a mano por fuera del servicio: aparece en reconciliar() con los valores correctos (no solo confirma el camino feliz)', async () => {
      const sessionId = await abrirSesionParaReconciliar(ownerId, '100.00');
      await prisma.$transaction((tx) =>
        service.registrarMovimiento(tx, {
          sessionId,
          tipo: CashMovementTipo.VENTA,
          monto: new Prisma.Decimal('400.00'),
          descripcion: 'Venta real para T3.6 (corrupción)',
          userId: ownerId,
        }),
      );
      // montoSistema real = 100 (inicial) + 400 (venta) = 500
      await prisma.$transaction((tx) =>
        service.cerrarSesion(tx, {
          sessionId,
          montoDeclarado: new Prisma.Decimal('500.00'),
          userId: ownerId,
          esOwner: true,
        }),
      );

      // Corrupción real, directo por Prisma, sorteando el servicio por
      // completo — mismo espíritu que el test de T2.8 que "prueba que el
      // chequeo detecta un desajuste real, no solo confirma el camino
      // feliz".
      await prisma.cashRegisterSession.update({
        where: { id: sessionId },
        data: { montoSistema: new Prisma.Decimal('999.00') },
      });

      const mismatches = await withReconciliar(service).reconciliar();

      const found = mismatches.find((m) => m.sessionId === sessionId);
      expect(found).toBeDefined();
      expect(new Prisma.Decimal(found!.montoSistemaGuardado).toString()).toBe(
        '999',
      );
      expect(
        new Prisma.Decimal(found!.montoSistemaRecalculado).toString(),
      ).toBe('500');
    });
  });
});
