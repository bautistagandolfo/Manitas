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
  SaleEstado,
  ReturnTipo,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../../src/app.module';
import type { EnvConfig } from '../../src/config/env.schema';

// Fase 04a (T5.7, mitad backend) — tests de integración HTTP escritos
// ANTES de la implementación, sesión aislada (sin visibilidad del resto de
// la conversación). Mismo criterio exacto que T4.11 (`SalesController`
// nació de una Fase 04a aunque T4.11 es nominalmente "frontend" en el
// roadmap): `ReturnsService` (T5.1–T5.6, VERDE) existe completo, pero no
// hay `ReturnsController`/`ReturnsModule`/DTOs todavía, ni registro en
// `AppModule`.
//
// Fuentes usadas — únicamente:
//   - `docs/build-protocol/state/ROADMAP.md` (T5.7, Etapa 5).
//   - `BLUEPRINT.md` §9.3, §9.4, §9.6, §9.7, §9.8, sección 6 (invariantes
//     7, 8, 10, 11, 13, 14, 15).
//   - `docs/build-protocol/state/reports/modulo-returns-spec.md` (sección
//     4 — SOLO las filas de `GET /returns/sales/:numero` y `POST
//     /returns`, no la de `GET /returns/:numero/credito`, T5.8 fuera de
//     alcance —, sección 6, sección 7, sección 8, sección 9).
//   - Contrato exacto fijado por el prompt de esta fase (body, header,
//     rol, forma de la respuesta), reconciliado con la firma exportada de
//     `returns.service.ts` (ver nota de contrato abajo).
//
// Lo único leído de `returns.service.ts` fueron las interfaces EXPORTADAS
// del principio del archivo (`CrearDevolucionItemInput`,
// `CrearDevolucionPaymentInput`, `CrearDevolucionVentaNuevaInput`,
// `CrearDevolucionInput`, y la firma `crearDevolucion(tx, input):
// Promise<Return>`), nunca el cuerpo del método.
//
// NOTA DE CONTRATO (reconciliación, decisión de esta sesión): la sección 4
// de `modulo-returns-spec.md` describe un campo `creditoAplicado?: {
// monto }` separado en el body de `POST /returns`. La interfaz REAL
// exportada `CrearDevolucionInput` no tiene ningún campo de ese tipo — y
// el comentario propio de `CrearDevolucionVentaNuevaInput.payments` («los
// pagos de este tipo son SOLO los pagos ADEMÁS del crédito») junto con
// RN-9 paso 2 de la misma spec («el CREDITO_DEVOLUCION es una línea más
// [de `return_payments`], no un caso especial de esa suma») confirman que
// el monto de crédito aplicado a un `CAMBIO` se manda como una línea más
// de `returnPayments` con `metodo: CREDITO_DEVOLUCION` — exactamente la
// forma que el prompt de esta fase describe (`returnPayments: [{ metodo,
// monto, referencia? }]`, sin campo `creditoAplicado` separado). Se siguió
// la interfaz exportada (fuente más mecánica y verificable) sobre la
// tabla de la sección 4, que quedó desactualizada respecto de cómo T5.5
// terminó implementando `CrearDevolucionInput` en la práctica. No se trata
// de una ambigüedad para detener la sesión: las dos fuentes primarias (RN-9
// y la interfaz real) coinciden entre sí, solo la tabla-resumen de la
// sección 4 quedó vieja.
//
// `ReturnsController`/`ReturnsModule` NO existen todavía — `AppModule` no
// los registra (confirmado leyendo `src/app.module.ts`: solo importa
// `SalesModule`, no hay ningún `ReturnsModule`). Este archivo entero debe
// fallar contra 404 en cada request a `/returns/...` hasta que existan,
// que es exactamente la ausencia que esta fase debe dejar documentada.

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

interface SaleReturnInfoItem {
  saleItemId: number;
  variantId: number;
  descripcionSnapshot: string;
  cantidadVendida: number;
  cantidadDisponible: number;
  netoLineaOriginal: string | number;
  netoLineaDisponible: string | number;
  costoUnitario?: string | number;
}

interface SaleReturnInfo {
  saleId: number;
  numero: number;
  fecha: string;
  estado: string;
  dentroDePlazo: boolean;
  items: SaleReturnInfoItem[];
  payments: Array<{ metodo: string; monto: string | number }>;
}

interface ReturnResponseBody {
  id: number;
  numero: number;
  saleId: number;
  saleNuevaId: number | null;
  saleNuevaNumero: number | null;
  totalDevuelto: string | number;
  tipo: string;
  idempotencyKey: string | null;
  autorizadoPorUserId: number | null;
}

describe('returns-controller (integration, T5.7 backend, fase 04a)', () => {
  let app: INestApplication<App>;
  let ownerId: number;
  let sellerId: number;
  let ownerCookie: string;
  let sellerCookie: string;
  let frontendUrl: string;

  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdSessionIds: number[] = [];
  const createdSaleIds: number[] = [];
  const createdReturnIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  // Mismo criterio que `sales-controller.integration.spec.ts`: el índice
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
      data: { nombre: `Producto test T5.7 ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `T5.7-${randomUUID()}`,
        precioVenta: new Prisma.Decimal(overrides.precioVenta ?? '100.00'),
        costoActual: new Prisma.Decimal(overrides.costoActual ?? '60.00'),
        stockActual: overrides.stockActual ?? 10,
        activo: true,
      },
    });
    createdVariantIds.push(variant.id);
    return { id: variant.id, stockActual: variant.stockActual };
  }

  // Crea una venta real vía HTTP (`POST /sales`, ya cerrado y en verde) de
  // una sola línea, y devuelve los datos que `returns` necesita para
  // armar sus propios fixtures — mismo criterio que
  // `sales-controller.integration.spec.ts` usa `createVariant` como
  // fixture propia sin tocar el módulo ajeno.
  async function crearVentaSimple(
    actor: (req: request.Test) => request.Test,
    opts: {
      variantId: number;
      cantidad: number;
      montoTotal: string;
      metodo?: PaymentMetodo;
    },
  ): Promise<{
    saleId: number;
    numero: number;
    saleItemId: number;
    netoLinea: Prisma.Decimal;
    costoUnitario: Prisma.Decimal;
  }> {
    const response = await actor(request(app.getHttpServer()).post('/sales'))
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ variantId: opts.variantId, cantidad: opts.cantidad }],
        payments: [
          {
            metodo: opts.metodo ?? PaymentMetodo.EFECTIVO,
            monto: opts.montoTotal,
          },
        ],
      })
      .expect(201);

    const body = response.body as { id: number; numero: number };
    createdSaleIds.push(body.id);

    const saleItem = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: body.id },
      orderBy: { id: 'asc' },
    });

    return {
      saleId: body.id,
      numero: body.numero,
      saleItemId: saleItem.id,
      netoLinea: saleItem.netoLinea,
      costoUnitario: saleItem.costoUnitario,
    };
  }

  async function anularVentaDirect(saleId: number): Promise<void> {
    await prisma.sale.update({
      where: { id: saleId },
      data: { estado: SaleEstado.ANULADA },
    });
  }

  async function envejecerVentaDirect(
    saleId: number,
    diasAtras: number,
  ): Promise<void> {
    const fecha = new Date();
    fecha.setDate(fecha.getDate() - diasAtras);
    await prisma.sale.update({ where: { id: saleId }, data: { fecha } });
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
        email: `returns-controller-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (returns controller)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `returns-controller-test-seller-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Seller de prueba (returns controller)',
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
    // Orden de FKs: `payments` referencia tanto `sales` como `returns`
    // (`return_id` opcional) — hay que borrarla primero, filtrando por
    // cualquiera de los dos.
    if (createdSaleIds.length > 0 || createdReturnIds.length > 0) {
      await prisma.payment.deleteMany({
        where: {
          OR: [
            { saleId: { in: createdSaleIds } },
            { returnId: { in: createdReturnIds } },
          ],
        },
      });
    }

    if (createdReturnIds.length > 0) {
      await prisma.returnPayment.deleteMany({
        where: { returnId: { in: createdReturnIds } },
      });
      await prisma.returnItem.deleteMany({
        where: { returnId: { in: createdReturnIds } },
      });
      await prisma.return.deleteMany({
        where: { id: { in: createdReturnIds } },
      });
    }

    if (createdSaleIds.length > 0) {
      await prisma.saleDiscount.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
      await prisma.saleItem.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
      await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
    }

    // Mismo hallazgo ya documentado en `sales-controller.integration.spec.ts`:
    // el trigger de inmutabilidad de `cash_movements` (T3.2) exige reabrir
    // cada sesión antes de poder borrar sus movimientos de prueba, una por
    // vez (el índice único parcial de sesión ABIERTA rechaza reabrir dos a
    // la vez).
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

  describe('GET /returns/sales/:numero', () => {
    it('caso 1 — venta con una línea, sin devoluciones previas: cantidadDisponible == cantidadVendida', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        costoActual: '60.00',
        stockActual: 10,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 4,
        montoTotal: '400.00',
      });

      const response = await owned(
        request(app.getHttpServer()).get(`/returns/sales/${venta.numero}`),
      ).expect(200);

      const body = response.body as SaleReturnInfo;
      expect(body.saleId).toBe(venta.saleId);
      expect(body.numero).toBe(venta.numero);
      expect(body.dentroDePlazo).toBe(true);
      expect(body.items).toHaveLength(1);

      const item = body.items[0];
      expect(item.saleItemId).toBe(venta.saleItemId);
      expect(item.variantId).toBe(variant.id);
      expect(item.cantidadVendida).toBe(4);
      expect(item.cantidadDisponible).toBe(4);
      expect(Number(item.netoLineaOriginal)).toBeCloseTo(
        venta.netoLinea.toNumber(),
        2,
      );
      expect(Number(item.netoLineaDisponible)).toBeCloseTo(
        venta.netoLinea.toNumber(),
        2,
      );

      expect(body.payments).toHaveLength(1);
      expect(body.payments[0].metodo).toBe(PaymentMetodo.EFECTIVO);
      expect(Number(body.payments[0].monto)).toBeCloseTo(400, 2);
    });

    it('caso 2 — con una devolución previa parcial: cantidadDisponible descontada correctamente', async () => {
      const sessionId = await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        costoActual: '60.00',
        stockActual: 10,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 4,
        montoTotal: '400.00',
      });

      // Devolución previa insertada directamente (POST /returns no existe
      // todavía en esta fase) — 1 de las 4 unidades, neto proporcional
      // exacto (100.00 de 400.00), sin necesidad de reproducir la lógica
      // de `crearDevolucion` para este fixture de lectura pura.
      const previa = await prisma.return.create({
        data: {
          saleId: venta.saleId,
          fecha: new Date(),
          userId: ownerId,
          cashRegisterSessionId: sessionId,
          tipo: ReturnTipo.DEVOLUCION,
          totalDevuelto: new Prisma.Decimal('100.00'),
          items: {
            create: [
              {
                saleItemId: venta.saleItemId,
                cantidad: 1,
                netoLinea: new Prisma.Decimal('100.00'),
                costoUnitario: venta.costoUnitario,
                reingresaStock: true,
              },
            ],
          },
        },
      });
      createdReturnIds.push(previa.id);

      const response = await owned(
        request(app.getHttpServer()).get(`/returns/sales/${venta.numero}`),
      ).expect(200);

      const body = response.body as SaleReturnInfo;
      const item = body.items[0];
      expect(item.cantidadVendida).toBe(4);
      expect(item.cantidadDisponible).toBe(3);
      expect(Number(item.netoLineaOriginal)).toBeCloseTo(400, 2);
      expect(Number(item.netoLineaDisponible)).toBeCloseTo(300, 2);
    });

    it('caso 3 — venta inexistente (numero que no existe) → 404', async () => {
      await owned(
        request(app.getHttpServer()).get('/returns/sales/999999999'),
      ).expect(404);
    });

    it('caso 4 — OWNER ve costoUnitario en items[], SELLER no (resolución de ambigüedad de esta sesión)', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '150.00',
        costoActual: '90.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '150.00',
      });

      const ownerResponse = await owned(
        request(app.getHttpServer()).get(`/returns/sales/${venta.numero}`),
      ).expect(200);
      const ownerBody = ownerResponse.body as SaleReturnInfo;
      expect(ownerBody.items[0].costoUnitario).toBeDefined();
      expect(Number(ownerBody.items[0].costoUnitario)).toBeCloseTo(90, 2);

      const sellerResponse = await sold(
        request(app.getHttpServer()).get(`/returns/sales/${venta.numero}`),
      ).expect(200);
      const sellerBody = sellerResponse.body as SaleReturnInfo;
      expect(sellerBody.items[0]).not.toHaveProperty('costoUnitario');
    });

    it('caso 5 — sin autenticación (sin cookie) → 401', async () => {
      await request(app.getHttpServer()).get('/returns/sales/1').expect(401);
    });
  });

  describe('POST /returns — tipo DEVOLUCION, camino feliz', () => {
    it('caso 6 — reintegro 100% efectivo → 201, return persistida, stock reingresado, cash_movement DEVOLUCION generado', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        costoActual: '60.00',
        stockActual: 10,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 3,
        montoTotal: '300.00',
      });

      const variantAfterVenta = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfterVenta.stockActual).toBe(7);

      const response = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 3,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '300.00' }],
        })
        .expect(201);

      const body = response.body as ReturnResponseBody;
      createdReturnIds.push(body.id);

      const returnRow = await prisma.return.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(returnRow.saleId).toBe(venta.saleId);
      expect(returnRow.totalDevuelto.toFixed(2)).toBe('300.00');

      // Ticket nuevo (post Release Candidate) — una DEVOLUCION simple
      // nunca genera venta nueva: `null`, no un número inventado.
      expect(body.saleNuevaNumero).toBeNull();

      const variantAfterReturn = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfterReturn.stockActual).toBe(10);

      const movement = await prisma.cashMovement.findFirst({
        where: { referenciaTipo: 'RETURN', referenciaId: body.id },
      });
      expect(movement).not.toBeNull();
      expect(movement?.tipo).toBe('DEVOLUCION');
      // RN-8 / cash-register.service.ts: DEVOLUCION siempre negativo.
      expect(movement?.monto.toFixed(2)).toBe('-300.00');
    });

    it('caso 7 — reingresaStock: false → dinero devuelto, stock intacto', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '80.00',
        costoActual: '50.00',
        stockActual: 10,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 2,
        montoTotal: '160.00',
      });

      const variantAfterVenta = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      expect(variantAfterVenta.stockActual).toBe(8);

      const response = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: false,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '80.00' }],
        })
        .expect(201);

      const body = response.body as ReturnResponseBody;
      createdReturnIds.push(body.id);

      const variantAfterReturn = await prisma.variant.findUniqueOrThrow({
        where: { id: variant.id },
      });
      // Stock NO cambia: la prenda fallada se pierde (RN-6).
      expect(variantAfterReturn.stockActual).toBe(8);

      const movement = await prisma.cashMovement.findFirst({
        where: { referenciaTipo: 'RETURN', referenciaId: body.id },
      });
      expect(movement).not.toBeNull();
      expect(movement?.monto.toFixed(2)).toBe('-80.00');
    });
  });

  describe('POST /returns — tipo CAMBIO', () => {
    it('caso 8 — precio igual: crédito completo, sale_nueva_id actualizado, payment CREDITO_DEVOLUCION ligado', async () => {
      await abrirSesion(owned);
      const variantOriginal = await createVariant({
        precioVenta: '150.00',
        costoActual: '90.00',
        stockActual: 5,
      });
      const variantNueva = await createVariant({
        precioVenta: '150.00',
        costoActual: '95.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variantOriginal.id,
        cantidad: 1,
        montoTotal: '150.00',
      });

      const response = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.CAMBIO,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [
            { metodo: PaymentMetodo.CREDITO_DEVOLUCION, monto: '150.00' },
          ],
          ventaNueva: {
            items: [{ variantId: variantNueva.id, cantidad: 1 }],
            payments: [],
          },
        })
        .expect(201);

      const body = response.body as ReturnResponseBody;
      createdReturnIds.push(body.id);

      const returnRow = await prisma.return.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(returnRow.tipo).toBe(ReturnTipo.CAMBIO);
      expect(returnRow.saleNuevaId).not.toBeNull();

      if (returnRow.saleNuevaId) {
        createdSaleIds.push(returnRow.saleNuevaId);

        // Ticket nuevo (post Release Candidate) — hallazgo real de uso:
        // sin esto, el número de la venta nueva no aparecía en ningún
        // lado (`saleNuevaId` es un id interno, no el número que
        // después sirve para encontrarla). Se verifica contra la venta
        // real, no un valor fijo.
        const ventaNuevaReal = await prisma.sale.findUniqueOrThrow({
          where: { id: returnRow.saleNuevaId },
        });
        expect(body.saleNuevaNumero).toBe(ventaNuevaReal.numero);
      }

      const creditPayment = await prisma.payment.findFirst({
        where: {
          returnId: body.id,
          metodo: PaymentMetodo.CREDITO_DEVOLUCION,
        },
      });
      expect(creditPayment).not.toBeNull();
      expect(creditPayment?.monto.toFixed(2)).toBe('150.00');
      expect(creditPayment?.saleId).toBe(returnRow.saleNuevaId);
    });
  });

  describe('idempotencia (RN-9, BLUEPRINT §9.7)', () => {
    it('caso 9 — sin header Idempotency-Key → 400', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });

    it('caso 10 — doble click: misma Idempotency-Key dos veces → misma Return, una sola fila', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '50.00',
        stockActual: 20,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 2,
        montoTotal: '100.00',
      });
      const key = randomUUID();
      const payload = {
        saleId: venta.saleId,
        tipo: ReturnTipo.DEVOLUCION,
        items: [
          { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
        ],
        returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '50.00' }],
      };

      const first = await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', key)
        .send(payload);
      expect([200, 201]).toContain(first.status);
      const firstBody = first.body as ReturnResponseBody;
      createdReturnIds.push(firstBody.id);

      const second = await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', key)
        .send(payload);
      expect([200, 201]).toContain(second.status);
      const secondBody = second.body as ReturnResponseBody;

      expect(secondBody.id).toBe(firstBody.id);

      const count = await prisma.return.count({
        where: { idempotencyKey: key },
      });
      expect(count).toBe(1);
    });
  });

  describe('errores de negocio (ya validados por crearDevolucion — confirma que llegan intactos hasta HTTP)', () => {
    it('caso 11 — venta inexistente → 404', async () => {
      await abrirSesion(owned);

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: 999999999,
          tipo: ReturnTipo.DEVOLUCION,
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '10.00' }],
        })
        .expect(404);
    });

    it('caso 12 — venta ANULADA → 409', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });
      await anularVentaDirect(venta.saleId);

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(409);
    });

    it('caso 13 — sin sesión de caja abierta → 409', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });
      await closeAnyOpenSessionDirect();

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(409);
    });

    it('caso 14 — cantidad a devolver excede lo disponible en la línea → 400', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 2,
        montoTotal: '200.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 5,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '500.00' }],
        })
        .expect(400);

      const returnRow = await prisma.return.findFirst({
        where: { saleId: venta.saleId },
      });
      expect(returnRow).toBeNull();
    });

    it('caso 15 — fuera de plazo, SELLER sin autorización → 400/403, y GET informa dentroDePlazo:false', async () => {
      await abrirSesion(sold);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(sold, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });
      await envejecerVentaDirect(venta.saleId, 40);

      const getResponse = await sold(
        request(app.getHttpServer()).get(`/returns/sales/${venta.numero}`),
      ).expect(200);
      expect((getResponse.body as SaleReturnInfo).dentroDePlazo).toBe(false);

      const response = await sold(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        });
      expect([400, 403]).toContain(response.status);

      const returnRow = await prisma.return.findFirst({
        where: { saleId: venta.saleId },
      });
      expect(returnRow).toBeNull();
    });

    it('caso 15b — fuera de plazo, OWNER se autoriza a sí mismo → 201, autorizadoPorUserId seteado', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });
      await envejecerVentaDirect(venta.saleId, 40);

      const response = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(201);

      const body = response.body as ReturnResponseBody;
      createdReturnIds.push(body.id);

      const returnRow = await prisma.return.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(returnRow.autorizadoPorUserId).toBe(ownerId);
    });

    it('caso 16 — SUM(returnPayments) != total_devuelto → 400', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '50.00' }],
        })
        .expect(400);
    });

    it('caso 17 — tipo CAMBIO sin ventaNueva → 400', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.CAMBIO,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [
            { metodo: PaymentMetodo.CREDITO_DEVOLUCION, monto: '100.00' },
          ],
        })
        .expect(400);
    });

    it('caso 17b — tipo DEVOLUCION con ventaNueva presente → 400 ("una devolución simple no lleva venta nueva")', async () => {
      await abrirSesion(owned);
      const variantOriginal = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const variantNueva = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variantOriginal.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
          ventaNueva: {
            items: [{ variantId: variantNueva.id, cantidad: 1 }],
            payments: [],
          },
        })
        .expect(400);
    });
  });

  describe('validación de DTO (ValidationPipe global, whitelist/forbidNonWhitelisted)', () => {
    it('caso 18 — body inválido, falta items → 400', async () => {
      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: 1,
          tipo: ReturnTipo.DEVOLUCION,
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });

    it('caso 19 — esOwner mandado en el body → 400 (forbidNonWhitelisted, esOwner siempre se resuelve del JWT)', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
          esOwner: true,
        })
        .expect(400);
    });

    it('caso 20 — más de 500 líneas en items → 400, rechazado antes de tocar crearDevolucion', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: Array.from({ length: 501 }, () => ({
            saleItemId: venta.saleItemId,
            cantidad: 1,
            reingresaStock: true,
          })),
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(400);
    });
  });

  describe('autenticación y autorización', () => {
    it('caso 21 — sin autenticación (sin cookie) → 401', async () => {
      await request(app.getHttpServer())
        .post('/returns')
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: 1,
          tipo: ReturnTipo.DEVOLUCION,
          items: [{ saleItemId: 1, cantidad: 1, reingresaStock: true }],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(401);
    });

    it('caso 22 — SELLER puede crear devolución dentro de plazo (RN-1, sin restricción de rol) → 201', async () => {
      await abrirSesion(sold);
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(sold, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      const response = await sold(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(201);

      const body = response.body as ReturnResponseBody;
      createdReturnIds.push(body.id);

      const returnRow = await prisma.return.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(returnRow.userId).toBe(sellerId);
    });

    // Fase 10 de `sales` (hallazgo HIGH matizado, CSRF) — mismo criterio,
    // `OriginCheckMiddleware` se aplica globalmente (`forRoutes('*')` en
    // `app.module.ts`) y ya cubriría `/returns` en cuanto exista la ruta.
    it('caso 23 — Origin cross-site (simula un atacante con la cookie real de la víctima) → 403, nada escrito', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({ stockActual: 5 });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .set('Origin', 'https://evil.example.com')
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(403);

      const returnRow = await prisma.return.findFirst({
        where: { saleId: venta.saleId },
      });
      expect(returnRow).toBeNull();
    });

    it('caso 24 — Origin que coincide con FRONTEND_URL (el frontend legítimo real) → sigue funcionando, 201', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '100.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '100.00',
      });

      const response = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .set('Origin', frontendUrl)
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            {
              saleItemId: venta.saleItemId,
              cantidad: 1,
              reingresaStock: true,
            },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
        })
        .expect(201);

      const body = response.body as ReturnResponseBody;
      createdReturnIds.push(body.id);
    });
  });

  // Fase 04a (T5.8, ticket nuevo) — `GET /returns/:numero/credito` NO
  // existe todavía (confirmado: `grep` sobre `returns.controller.ts` no
  // encuentra ninguna ruta `credito`). Contrato fijado por el prompt de
  // esta fase, reconciliado con `docs/build-protocol/state/reports/
  // modulo-returns-spec.md` sección 4 (fila nueva del endpoint) y sección
  // 6 (edge case literal: una devolución que en realidad fue el resultado
  // de un CAMBIO responde igual, sin distinción por `tipo`). Cada caso de
  // este describe debe fallar por 404 (ruta inexistente) hasta que exista
  // el controller/servicio — no por un error de compilación.
  //
  // Fixtures: en vez de insertar `Payment`/`Return` a mano para simular
  // consumo de crédito por una venta separada (que exigiría reconstruir
  // una fila `Sale` completa y válida sin tocar el cuerpo de
  // `crearVenta`), se usa el mecanismo `CAMBIO` real (`POST /returns` ya
  // VERDE desde T5.5/T5.7) para generar consumo íntegro o parcial del
  // crédito de una devolución dentro de una misma transacción conocida —
  // exactamente el camino que sección 6 documenta como equivalente
  // ("responde igual", sin importar si el origen del crédito fue un
  // `CAMBIO`). El consumo por una venta HTTP separada con `returnId`
  // (T5.5/T5.8 en `sales`) se cubre en su propio archivo
  // (`sales-controller.integration.spec.ts`), no acá.
  describe('GET /returns/:numero/credito (T5.8, crédito diferido)', () => {
    // T5.8 — hallazgo real de esta sesión: este caso originalmente esperaba
    // `creditoDisponible == totalDevuelto` (120) para una devolución simple
    // (100% efectivo), asumiendo que "nada se consumió" implicaba "todo
    // sigue disponible como crédito" — pero una devolución simple RECHAZA
    // cualquier pago `CREDITO_DEVOLUCION` (paso 0b de `crearDevolucion`:
    // "una devolución simple no genera crédito"), así que nunca existió
    // ningún `return_payment` marcado como crédito para ella. El techo real
    // (`SUM(return_payments) WHERE metodo = CREDITO_DEVOLUCION`) es $0, no
    // `total_devuelto` — corregido a `creditoDisponible == 0`, único cambio
    // en este `it`.
    it('caso 25 — devolución simple (sin cambio): nunca generó crédito, creditoDisponible == 0', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '120.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '120.00',
      });

      const returnResponse = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '120.00' }],
        })
        .expect(201);
      const returnBody = returnResponse.body as ReturnResponseBody;
      createdReturnIds.push(returnBody.id);

      const creditoResponse = await owned(
        request(app.getHttpServer()).get(
          `/returns/${returnBody.numero}/credito`,
        ),
      ).expect(200);

      const credito = creditoResponse.body as {
        returnId: number;
        numero: number;
        totalDevuelto: string | number;
        creditoConsumido: string | number;
        creditoDisponible: string | number;
        saleId: number;
      };
      expect(credito.returnId).toBe(returnBody.id);
      expect(credito.numero).toBe(returnBody.numero);
      expect(credito.saleId).toBe(venta.saleId);
      expect(Number(credito.totalDevuelto)).toBeCloseTo(120, 2);
      expect(Number(credito.creditoConsumido)).toBeCloseTo(0, 2);
      // No $120 — una devolución simple nunca marca nada como
      // CREDITO_DEVOLUCION, así que no hay ningún crédito que aplicar.
      expect(Number(credito.creditoDisponible)).toBeCloseTo(0, 2);
    });

    it('caso 26 — devolución resultado de un CAMBIO a precio igual: crédito íntegramente consumido, creditoDisponible == 0', async () => {
      await abrirSesion(owned);
      const variantOriginal = await createVariant({
        precioVenta: '150.00',
        stockActual: 5,
      });
      const variantNueva = await createVariant({
        precioVenta: '150.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variantOriginal.id,
        cantidad: 1,
        montoTotal: '150.00',
      });

      const returnResponse = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.CAMBIO,
          items: [
            { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [
            { metodo: PaymentMetodo.CREDITO_DEVOLUCION, monto: '150.00' },
          ],
          ventaNueva: {
            items: [{ variantId: variantNueva.id, cantidad: 1 }],
            payments: [],
          },
        })
        .expect(201);
      const returnBody = returnResponse.body as ReturnResponseBody;
      createdReturnIds.push(returnBody.id);
      if (returnBody.saleNuevaId) {
        createdSaleIds.push(returnBody.saleNuevaId);
      }

      const creditoResponse = await owned(
        request(app.getHttpServer()).get(
          `/returns/${returnBody.numero}/credito`,
        ),
      ).expect(200);

      const credito = creditoResponse.body as {
        totalDevuelto: string | number;
        creditoConsumido: string | number;
        creditoDisponible: string | number;
      };
      expect(Number(credito.totalDevuelto)).toBeCloseTo(150, 2);
      expect(Number(credito.creditoConsumido)).toBeCloseTo(150, 2);
      expect(Number(credito.creditoDisponible)).toBeCloseTo(0, 2);
    });

    // T5.8 — hallazgo real de esta sesión: la aserción de `creditoDisponible`
    // de este caso originalmente esperaba $70 (`totalDevuelto` 200 menos
    // `creditoConsumido` 130), reproduciendo sin darse cuenta un bug real de
    // double-spend — reproducido en vivo durante la verificación manual de
    // T5.8: el excedente de $70 ya se reintegró en EFECTIVO en el momento
    // del cambio (es una línea de `return_payments` separada, no crédito),
    // así que no puede quedar TAMBIÉN disponible como crédito. El techo real
    // es lo que se marcó como `CREDITO_DEVOLUCION` (los $130 que sí se
    // aplicaron a la venta nueva), no `total_devuelto` — con ese techo, una
    // vez consumidos esos $130 en la propia venta del cambio, no queda más
    // crédito. Corregido a $0, único cambio en este `it` — nada más del
    // archivo se tocó.
    it('caso 27 — devolución resultado de un CAMBIO a precio menor: el excedente ya reintegrado en efectivo NO queda disponible como crédito', async () => {
      await abrirSesion(owned);
      const variantOriginal = await createVariant({
        precioVenta: '200.00',
        stockActual: 5,
      });
      const variantNueva = await createVariant({
        precioVenta: '130.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variantOriginal.id,
        cantidad: 1,
        montoTotal: '200.00',
      });

      // Cambio con excedente: 200.00 devueltos, solo 130.00 se aplican
      // como crédito a la venta nueva, los 70.00 restantes se reintegran
      // por otro medio (sección 6 — "prenda nueva más barata").
      const returnResponse = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.CAMBIO,
          items: [
            { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [
            { metodo: PaymentMetodo.CREDITO_DEVOLUCION, monto: '130.00' },
            { metodo: PaymentMetodo.EFECTIVO, monto: '70.00' },
          ],
          ventaNueva: {
            items: [{ variantId: variantNueva.id, cantidad: 1 }],
            payments: [],
          },
        })
        .expect(201);
      const returnBody = returnResponse.body as ReturnResponseBody;
      createdReturnIds.push(returnBody.id);
      if (returnBody.saleNuevaId) {
        createdSaleIds.push(returnBody.saleNuevaId);
      }

      const creditoResponse = await owned(
        request(app.getHttpServer()).get(
          `/returns/${returnBody.numero}/credito`,
        ),
      ).expect(200);

      const credito = creditoResponse.body as {
        totalDevuelto: string | number;
        creditoConsumido: string | number;
        creditoDisponible: string | number;
      };
      expect(Number(credito.totalDevuelto)).toBeCloseTo(200, 2);
      expect(Number(credito.creditoConsumido)).toBeCloseTo(130, 2);
      // No $70 (total_devuelto - creditoConsumido) — ese excedente ya se
      // reintegró en efectivo, nunca fue crédito. Ver comentario del `it`.
      expect(Number(credito.creditoDisponible)).toBeCloseTo(0, 2);
    });

    it('caso 28 — numero inexistente → 404 "Devolución no encontrada"', async () => {
      const response = await owned(
        request(app.getHttpServer()).get('/returns/999999999/credito'),
      ).expect(404);
      expect(JSON.stringify(response.body)).toContain(
        'Devolución no encontrada',
      );
    });

    it('caso 29 — ambos roles (OWNER/SELLER) pueden consultar, sin restricción (sección 8)', async () => {
      await abrirSesion(owned);
      const variant = await createVariant({
        precioVenta: '90.00',
        stockActual: 5,
      });
      const venta = await crearVentaSimple(owned, {
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '90.00',
      });

      const returnResponse = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          items: [
            { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '90.00' }],
        })
        .expect(201);
      const returnBody = returnResponse.body as ReturnResponseBody;
      createdReturnIds.push(returnBody.id);

      await sold(
        request(app.getHttpServer()).get(
          `/returns/${returnBody.numero}/credito`,
        ),
      ).expect(200);
    });

    it('caso 30 — sin autenticación (sin cookie) → 401', async () => {
      await request(app.getHttpServer()).get('/returns/1/credito').expect(401);
    });
  });
});
