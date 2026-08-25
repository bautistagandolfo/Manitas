import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  Prisma,
  PrismaClient,
  UserRole,
  CashRegisterSessionEstado,
  PaymentMetodo,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import type { EnvConfig } from '../../src/config/env.schema';

// Fase 04a (T4.11) — tests de integración HTTP escritos ANTES de la
// implementación, sesión aislada (sin visibilidad del resto de la
// conversación).
//
// Fuentes usadas — únicamente:
//   - `docs/build-protocol/state/ROADMAP.md` (T4.11, Etapa 4, nota de
//     alcance de T4.10).
//   - `BLUEPRINT.md` §5.3, §9.3, §9.4, §9.6, §9.7, §9.8, sección 6
//     (invariantes 3, 4, 7, 10, 12).
//   - `docs/build-protocol/state/reports/modulo-sales-spec.md` (RN-1 a
//     RN-10, secciones 4.1, 6, 7, 8, 9).
//   - Contrato exacto de `POST /sales` fijado por el prompt de esta fase
//     (body, header, rol, forma de la respuesta).
//
// Lo único leído de `sales.service.ts` fue la FIRMA exportada
// (`CrearVentaInput`/`crearVenta(tx, input): Promise<Sale>`), nunca el
// cuerpo del método — autorizado explícitamente para conocer la forma
// exacta del input. La ESTRUCTURA MECÁNICA (nunca la lógica de negocio)
// de `cash-registers.controller.ts`/`cash-registers.module.ts` (T3.3) y de
// `test/integration/cash-registers.integration.spec.ts` (helpers
// `owned()`/`sold()`, patrón de limpieza con reapertura de sesión antes de
// borrar `cash_movements` por el trigger de inmutabilidad) se usó como
// plantilla del patrón HTTP + idempotencia ya establecido en este
// proyecto.
//
// `SalesController`/`SalesModule` NO existen todavía — `AppModule` no los
// registra (confirmado leyendo `src/app.module.ts` como wiring de
// infraestructura, no como lógica de negocio de `sales`). Este archivo
// entero debe fallar contra 404 en cada request a `/sales` hasta que
// existan, que es exactamente la ausencia que esta fase debe dejar
// documentada.

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

describe('sales-controller (integration, T4.11)', () => {
  let app: INestApplication<App>;
  let sellerId: number;
  let ownerCookie: string;
  let sellerCookie: string;
  let frontendUrl: string;

  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdSessionIds: number[] = [];
  const createdSaleIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  // Mismo criterio que `cash-registers.integration.spec.ts`: el índice
  // único parcial "una sola sesión ABIERTA" (invariante 9, ya VERDE)
  // bloquea abrir una sesión nueva mientras quede alguna abierta de un
  // test anterior.
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

  async function abrirSesion(
    actor: (req: request.Test) => request.Test = owned,
    montoInicial = '1000.00',
  ): Promise<number> {
    const response = await actor(
      request(app.getHttpServer()).post('/cash-registers/sessions'),
    )
      .send({ montoInicial })
      .expect(201);
    const body = response.body as { id: number };
    createdSessionIds.push(body.id);
    return body.id;
  }

  async function createVariant(
    overrides: {
      precioVenta?: string;
      costoActual?: string;
      stockActual?: number;
    } = {},
  ): Promise<{ id: number; stockActual: number }> {
    const product = await prisma.product.create({
      data: { nombre: `Producto test T4.11 ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `T4.11-${randomUUID()}`,
        precioVenta: new Prisma.Decimal(overrides.precioVenta ?? '100.00'),
        costoActual: new Prisma.Decimal(overrides.costoActual ?? '60.00'),
        stockActual: overrides.stockActual ?? 10,
        activo: true,
      },
    });
    createdVariantIds.push(variant.id);
    return { id: variant.id, stockActual: variant.stockActual };
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    frontendUrl = moduleFixture
      .get<ConfigService<EnvConfig, true>>(ConfigService)
      .get('FRONTEND_URL', { infer: true });

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: `sales-controller-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (sales controller)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `sales-controller-test-seller-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Seller de prueba (sales controller)',
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
    if (createdSaleIds.length > 0) {
      await prisma.payment.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
      await prisma.saleDiscount.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
      await prisma.saleItem.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
    }

    // `sales.cash_register_session_id` es FK hacia la sesión — hay que
    // borrar las ventas ANTES de poder borrar la sesión que referencian.
    if (createdSaleIds.length > 0) {
      await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
    }

    // El trigger `cash_movements_immutable_after_close` (T3.2) bloquea
    // cualquier escritura sobre `cash_movements` de una sesión CERRADA —
    // hay que reabrir cada sesión antes de poder borrar sus movimientos
    // de prueba. Una sesión por vez, de punta a punta (reabrir → borrar
    // sus movimientos → borrar la sesión), nunca reabriendo todas en
    // lote: el índice único parcial "una sola sesión ABIERTA" (invariante
    // 9) rechazaría la segunda reapertura mientras la primera siga
    // ABIERTA — mismo bug ya corregido en `sales.integration.spec.ts`
    // (T4.1) y `sales-anulacion.integration.spec.ts` (T4.7).
    for (const id of new Set(createdSessionIds)) {
      await prisma.cashRegisterSession.update({
        where: { id },
        data: { estado: CashRegisterSessionEstado.ABIERTA },
      });
      await prisma.cashMovement.deleteMany({ where: { sessionId: id } });
      await prisma.cashRegisterSession.delete({ where: { id } });
    }

    if (createdVariantIds.length > 0) {
      await prisma.stockMovement.deleteMany({
        where: { variantId: { in: createdVariantIds } },
      });
      await prisma.variant.deleteMany({
        where: { id: { in: createdVariantIds } },
      });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
    await prisma.$disconnect();
  });

  describe('camino feliz', () => {
    it('caso 1 — OWNER, un ítem, pago en efectivo exacto → 201, venta persistida, stock descontado, cash_movement VENTA generado', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '250.00',
        stockActual: 10,
      });
      const idempotencyKey = randomUUID();

      const response = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', idempotencyKey)
        .send({
          items: [{ variantId: variant.id, cantidad: 3 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '750.00' }],
        })
        .expect(201);

      const body = response.body as { id: number; idempotencyKey: string };
      createdSaleIds.push(body.id);
      expect(body.idempotencyKey).toBe(idempotencyKey);

      const sale = await prisma.sale.findUnique({ where: { id: body.id } });
      expect(sale).not.toBeNull();
      expect(sale?.subtotal.toFixed(2)).toBe('750.00');
      expect(sale?.total.toFixed(2)).toBe('750.00');
      expect(sale?.idempotencyKey).toBe(idempotencyKey);

      const variantAfter = await prisma.variant.findUnique({
        where: { id: variant.id },
      });
      expect(variantAfter?.stockActual).toBe(7);

      const movement = await prisma.cashMovement.findFirst({
        where: { referenciaTipo: 'SALE', referenciaId: body.id },
      });
      expect(movement).not.toBeNull();
      expect(movement?.tipo).toBe('VENTA');
      expect(movement?.monto.toFixed(2)).toBe('750.00');
    });

    it('caso 2 — SELLER también puede vender (RN-1: "cualquiera autenticado, es su trabajo") → 201, sin restricción de rol', async () => {
      await abrirSesion(sold);
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const idempotencyKey = randomUUID();

      const response = await sold(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', idempotencyKey)
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(201);

      const body = response.body as { id: number };
      createdSaleIds.push(body.id);

      const sale = await prisma.sale.findUnique({ where: { id: body.id } });
      expect(sale).not.toBeNull();
      expect(sale?.userId).toBe(sellerId);
    });

    it('caso 3 — descuento + ajuste de redondeo llegan hasta crearVenta y el total persistido es el correcto', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 5,
      });
      const idempotencyKey = randomUUID();

      // subtotal 1000.00, descuento 10% = 100.00, ajuste +0.50
      // → total = 1000.00 - 100.00 + 0.50 = 900.50 (BLUEPRINT §9.3)
      const response = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', idempotencyKey)
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          discounts: [{ descripcion: 'Promo test', porcentaje: '10.00' }],
          ajusteRedondeo: '0.50',
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '900.50' }],
        })
        .expect(201);

      const body = response.body as { id: number };
      createdSaleIds.push(body.id);

      const sale = await prisma.sale.findUnique({ where: { id: body.id } });
      expect(sale).not.toBeNull();
      expect(sale?.subtotal.toFixed(2)).toBe('1000.00');
      expect(sale?.descuentoTotal.toFixed(2)).toBe('100.00');
      expect(sale?.ajusteRedondeo.toFixed(2)).toBe('0.50');
      expect(sale?.total.toFixed(2)).toBe('900.50');
    });
  });

  describe('idempotencia (RN-9, BLUEPRINT §9.7)', () => {
    it('caso 4 — sin header Idempotency-Key → 400', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });

      await owned(request(app.getHttpServer()).post('/sales'))
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });

    it('caso 5 — doble click: mismo Idempotency-Key mandado dos veces seguidas responde 200/201 con el mismo id, pero queda UNA sola fila en sales', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '50.00',
        stockActual: 20,
      });
      const key = randomUUID();
      const body = {
        items: [{ variantId: variant.id, cantidad: 2 }],
        payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
      };

      const first = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(first.status);
      const firstBody = first.body as { id: number };
      createdSaleIds.push(firstBody.id);

      const second = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', key)
        .send(body);
      expect([200, 201]).toContain(second.status);
      const secondBody = second.body as { id: number };

      expect(secondBody.id).toBe(firstBody.id);

      const count = await prisma.sale.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });

    it('caso 6 — dos Idempotency-Key distintas → dos ventas distintas, sin interferencia', async () => {
      await abrirSesion(owned);
      const variantA = await createVariant({
        precioVenta: '80.00',
        stockActual: 10,
      });
      const variantB = await createVariant({
        precioVenta: '80.00',
        stockActual: 10,
      });

      const first = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variantA.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '80.00' }],
        })
        .expect(201);

      const second = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variantB.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '80.00' }],
        })
        .expect(201);

      const firstBody = first.body as { id: number };
      const secondBody = second.body as { id: number };
      createdSaleIds.push(firstBody.id, secondBody.id);

      expect(firstBody.id).not.toBe(secondBody.id);
    });
  });

  describe('errores de negocio (ya validados por crearVenta — confirma que llegan intactos hasta HTTP)', () => {
    it('caso 7 — sin sesión de caja abierta → 409 (no se transforma en 500 genérico)', async () => {
      await closeAnyOpenSessionDirect();
      const variant = await createVariant({ stockActual: 5 });

      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(409);
    });

    it('caso 8 — stock insuficiente → 409 con mensaje que menciona cuánto hay disponible', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '10.00',
        stockActual: 3,
      });

      const response = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variant.id, cantidad: 99 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '990.00' }],
        })
        .expect(409);

      expect(JSON.stringify(response.body)).toContain('3');

      const variantAfter = await prisma.variant.findUnique({
        where: { id: variant.id },
      });
      expect(variantAfter?.stockActual).toBe(3);
    });

    it('caso 9 — SUM(payments) != total → 400', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });

      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '50.00' }],
        })
        .expect(400);
    });
  });

  describe('validación de DTO (ValidationPipe global, whitelist/forbidNonWhitelisted)', () => {
    it('caso 10 — body inválido, falta items → 400', async () => {
      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });

    it('caso 11 — body inválido, items vacío → 400', async () => {
      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });

    it('caso 12 — variantId/cantidad con tipo incorrecto (string en vez de number) → 400', async () => {
      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: 'abc', cantidad: 'dos' }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });

    // Fase 10 (security remediation) — hallazgo LOW de la fase 09 (sección
    // 6): sin `@ArrayMaxSize`, este body pasaba la validación de forma
    // íntegro. 501 líneas > el máximo de 500 de `CreateSaleDto`.
    it('caso 12b — más de 500 líneas en items → 400, rechazado antes de tocar crearVenta', async () => {
      const variant = await createVariant({ stockActual: 1000 });

      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: Array.from({ length: 501 }, () => ({
            variantId: variant.id,
            cantidad: 1,
          })),
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });

    it('caso 12c — más de 20 pagos → 400', async () => {
      const variant = await createVariant({ stockActual: 5 });

      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: Array.from({ length: 21 }, () => ({
            metodo: PaymentMetodo.EFECTIVO,
            monto: '1.00',
          })),
        })
        .expect(400);
    });
  });

  describe('autenticación y autorización', () => {
    it('caso 13 — sin autenticación (sin cookie de sesión) → 401', async () => {
      const variant = await createVariant({ stockActual: 5 });

      await request(app.getHttpServer())
        .post('/sales')
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(401);
    });

    it('caso 14 — esOwner no se puede falsificar desde el cliente: un SELLER manda esOwner:true junto con un descuento que supera su tope y la venta igual se rechaza', async () => {
      await abrirSesion(sold);
      const variant = await createVariant({
        precioVenta: '1000.00',
        stockActual: 5,
      });
      const idempotencyKey = randomUUID();

      // Tope por defecto del vendedor es 10% (max_descuento_vendedor_pct).
      // 50% lo excede ampliamente — si `esOwner` se resolviera del body en
      // vez del rol real del usuario logueado, esta venta pasaría.
      await sold(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', idempotencyKey)
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          discounts: [
            { descripcion: 'Descuento forzado', porcentaje: '50.00' },
          ],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '500.00' }],
          esOwner: true,
        })
        .expect(400);

      const sale = await prisma.sale.findUnique({
        where: { idempotencyKey },
      });
      expect(sale).toBeNull();

      const variantAfter = await prisma.variant.findUnique({
        where: { id: variant.id },
      });
      expect(variantAfter?.stockActual).toBe(5);
    });

    // Fase 10 (security remediation) — hallazgo HIGH matizado de la fase
    // 09 (CSRF, `state/reports/modulo-sales-secaudit-2026-08-25.md`,
    // sección 9): un fetch()/XHR cross-origin con la cookie real de una
    // víctima logueada, mandando `Content-Type: application/json` (el
    // único vector que pasa `jsonOnlyMiddleware`), tiene que rechazarse
    // ANTES de tocar la sesión o el negocio si el header `Origin` no
    // coincide con `FRONTEND_URL` — `OriginCheckMiddleware`, segunda
    // barrera independiente de que el preflight de CORS esté bien
    // configurado.
    it('caso 15 — Origin cross-site (simula un atacante con la cookie real de la víctima) → 403, nada escrito', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });

      await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .set('Origin', 'https://evil.example.com')
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(403);

      const variantAfter = await prisma.variant.findUnique({
        where: { id: variant.id },
      });
      expect(variantAfter?.stockActual).toBe(5);
    });

    it('caso 16 — Origin que coincide con FRONTEND_URL (el frontend legítimo real) → sigue funcionando, 201', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });

      const response = await owned(request(app.getHttpServer()).post('/sales'))
        .set('Idempotency-Key', randomUUID())
        .set('Origin', frontendUrl)
        .send({
          items: [{ variantId: variant.id, cantidad: 1 }],
          payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(201);

      const body = response.body as { id: number };
      createdSaleIds.push(body.id);
    });
  });
});
