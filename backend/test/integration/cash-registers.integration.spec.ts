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
import { AppModule } from '../../src/app.module';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { CashRegisterService } from '../../src/modules/cash-registers/cash-register.service';

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
const service = new CashRegisterService(prisma as unknown as PrismaService);

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
    if (createdSessionIds.length > 0) {
      await prisma.cashMovement.deleteMany({
        where: { sessionId: { in: createdSessionIds } },
      });
      await prisma.cashRegisterSession.deleteMany({
        where: { id: { in: createdSessionIds } },
      });
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
      await owned(
        request(app.getHttpServer()).post('/cash-registers/sessions'),
      )
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

      await sold(
        request(app.getHttpServer()).post('/cash-registers/sessions'),
      )
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
});
