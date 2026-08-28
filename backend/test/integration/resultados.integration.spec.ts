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
  ExpenseMedioPago,
  ReturnTipo,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { SalesService } from '../../src/modules/sales/sales.service';

// Fase 04a (T6.4) — tests de integración escritos ANTES de la
// implementación, contra Postgres real (nunca mockeado). Sesión aislada:
// no se leyó ningún archivo `resultados*` (no existía todavía).
//
// Fuentes usadas — únicamente: el ticket T6.4 pasado en el prompt de
// esta fase (`ROADMAP.md`, BLUEPRINT §5.6 y su fórmula textual, tabla de
// errores de la spec del módulo sección 7); y, como convención MECÁNICA
// del repo (nunca como fuente de la lógica de `resultados`):
//   - `sales-anulacion.integration.spec.ts`: cómo invocar
//     `salesService.anularVenta(tx, { saleId, userId, esOwner })` —
//     método sin ruta HTTP todavía, se llama directo dentro de
//     `prisma.$transaction`.
//   - `returns-controller.integration.spec.ts`: forma del body de
//     `POST /returns` (`items[].reingresaStock`, `returnPayments`) y su
//     helper `envejecerVentaDirect` (precedente ya establecido de mover
//     `fecha` de una fila directo por Prisma en un test, sin trigger que
//     lo bloquee — a diferencia de `cash_movements` tras el cierre).
//   - `expenses.integration.spec.ts`: setup de usuarios/cookies y
//     apertura/cierre de sesión de caja por HTTP.
//
// `ResultadosController`/`ResultadosService` SÍ existen ya (stub de esta
// misma fase, `GET /resultados` registrado en `AppModule` vía
// `ExpensesModule`) — pero `consultar()` siempre rechaza con un Error
// genérico ("T6.4 todavía no implementado"), nunca los status HTTP
// reales. Este archivo entero debe quedar en rojo por eso (probablemente
// 500 en los casos que hoy deberían dar 200/400), nunca por compilación.
//
// Estrategia anti-contaminación: cada escenario usa una `fecha` fija,
// explícita y exclusiva de ese test (años 2031/2032, muy lejos de
// "hoy" y sin superposición entre tests de este archivo), escrita
// directo por Prisma después de crear el fixture por HTTP — así el
// cálculo no depende de qué otros datos existan en la base ese mismo
// día real, ni del orden de ejecución de otros archivos de integración
// (todos corren con `maxWorkers: 1`, pero no vale la pena depender de
// eso).

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

interface RankingProductoItemBody {
  variantId: number;
  descripcionSnapshot: string;
  unidadesVendidas: number;
  margenTotal: string;
}

interface GastoPorCategoriaItemBody {
  expenseCategoryId: number;
  nombre: string;
  total: string;
}

interface ResultadosBody {
  ingresos: string;
  cmv: string;
  margenBruto: string;
  margenBrutoPct: string;
  gastos: string;
  resultadoNeto: string;
  calculadoEn: string;
  periodo: { desde: string; hasta: string };
}

describe('resultados (integration, T6.4)', () => {
  let app: INestApplication<App>;
  let salesService: SalesService;
  let ownerCookie: string;
  let sellerCookie: string;
  let ownerId: number;

  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdSessionIds: number[] = [];
  const createdSaleIds: number[] = [];
  const createdReturnIds: number[] = [];
  const createdExpenseIds: number[] = [];
  const createdCategoryIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
  }

  function sold(req: request.Test): request.Test {
    return req.set('Cookie', sellerCookie);
  }

  async function abrirSesion(montoInicial = '1000.00'): Promise<number> {
    const response = await owned(
      request(app.getHttpServer()).post('/cash-registers/sessions'),
    )
      .send({ montoInicial })
      .expect(201);
    const id = (response.body as { id: number }).id;
    createdSessionIds.push(id);
    return id;
  }

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

  async function createVariant(
    overrides: {
      precioVenta?: string;
      costoActual?: string;
      stockActual?: number;
    } = {},
  ): Promise<{ id: number }> {
    const product = await prisma.product.create({
      data: { nombre: `Producto test T6.4 ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `T6.4-${randomUUID()}`,
        precioVenta: new Prisma.Decimal(overrides.precioVenta ?? '100.00'),
        costoActual: new Prisma.Decimal(overrides.costoActual ?? '60.00'),
        stockActual: overrides.stockActual ?? 10,
        activo: true,
      },
    });
    createdVariantIds.push(variant.id);
    return { id: variant.id };
  }

  // Venta real, completa, vía `POST /sales` (ya cerrado y en verde) — una
  // sola línea. Devuelve lo que los tests de `resultados` necesitan para
  // armar sus propios escenarios, sin tocar el módulo `sales`.
  async function crearVentaCompletada(opts: {
    variantId: number;
    cantidad: number;
    montoTotal: string;
  }): Promise<{
    saleId: number;
    saleItemId: number;
    costoUnitario: Prisma.Decimal;
  }> {
    const response = await owned(request(app.getHttpServer()).post('/sales'))
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ variantId: opts.variantId, cantidad: opts.cantidad }],
        payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: opts.montoTotal }],
      })
      .expect(201);

    const body = response.body as { id: number };
    createdSaleIds.push(body.id);

    const saleItem = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: body.id },
      orderBy: { id: 'asc' },
    });

    return {
      saleId: body.id,
      saleItemId: saleItem.id,
      costoUnitario: saleItem.costoUnitario,
    };
  }

  // Mueve `sales.fecha` a un valor fijo, exclusivo del escenario que lo
  // llama — precedente ya establecido por `envejecerVentaDirect` de
  // `returns-controller.integration.spec.ts` (mover `fecha` directo por
  // Prisma en un test es un patrón mecánico ya usado, `sales` no tiene
  // ningún trigger de inmutabilidad como sí tiene `cash_movements`).
  async function fijarFechaVenta(saleId: number, fecha: Date): Promise<void> {
    await prisma.sale.update({ where: { id: saleId }, data: { fecha } });
  }

  async function fijarFechaDevolucion(
    returnId: number,
    fecha: Date,
  ): Promise<void> {
    await prisma.return.update({ where: { id: returnId }, data: { fecha } });
  }

  async function crearCategoria(nombre: string): Promise<number> {
    const categoria = await prisma.expenseCategory.create({
      data: { nombre },
    });
    createdCategoryIds.push(categoria.id);
    return categoria.id;
  }

  // Gasto insertado directo por Prisma (no vía `POST /expenses`): permite
  // fijar `fecha` con precisión exacta, que es justo lo que el filtro 3
  // estructural necesita probar.
  async function crearGastoDirect(
    categoryId: number,
    monto: string,
    fecha: Date,
  ): Promise<number> {
    const expense = await prisma.expense.create({
      data: {
        fecha,
        expenseCategoryId: categoryId,
        descripcion: 'Gasto de prueba (resultados, T6.4)',
        monto: new Prisma.Decimal(monto),
        medioPago: ExpenseMedioPago.OTRO,
        userId: ownerId,
      },
    });
    createdExpenseIds.push(expense.id);
    return expense.id;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    salesService = app.get(SalesService);

    const passwordHash = await argon2.hash('password123');

    const owner = await prisma.user.create({
      data: {
        email: `resultados-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (resultados)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const seller = await prisma.user.create({
      data: {
        email: `resultados-test-seller-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Seller de prueba (resultados)',
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

  afterEach(async () => {
    await closeAnyOpenSessionDirect();
  });

  afterAll(async () => {
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

    if (createdExpenseIds.length > 0) {
      await prisma.expense.deleteMany({
        where: { id: { in: createdExpenseIds } },
      });
    }
    if (createdCategoryIds.length > 0) {
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

  describe('autenticación y rol (RN-11 — OWNER-only)', () => {
    it('GET /resultados sin sesión → 401', async () => {
      await request(app.getHttpServer()).get('/resultados').expect(401);
    });

    it('GET /resultados con SELLER → 403', async () => {
      await sold(request(app.getHttpServer()).get('/resultados')).expect(403);
    });
  });

  describe('validación de rango', () => {
    it('desde > hasta → 400 "El rango de fechas no es válido"', async () => {
      const response = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2026-02-15', hasta: '2026-01-01' });

      expect(response.status).toBe(400);
    });
  });

  describe('camino feliz', () => {
    it('una venta completada real: ingresos incluye su total, cmv incluye cantidad × costoUnitario de sus líneas', async () => {
      await abrirSesion();
      const variant = await createVariant({
        precioVenta: '100.00',
        costoActual: '60.00',
        stockActual: 10,
      });
      const venta = await crearVentaCompletada({
        variantId: variant.id,
        cantidad: 2,
        montoTotal: '200.00',
      });
      await fijarFechaVenta(venta.saleId, new Date('2031-01-05T10:00:00.000Z'));

      const response = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2031-01-05', hasta: '2031-01-05' });

      expect(response.status).toBe(200);
      const body = response.body as ResultadosBody;
      // costoUnitario congelado de la línea × cantidad = CMV esperado.
      const cmvEsperado = venta.costoUnitario.times(2).toFixed(2);
      expect(body.ingresos).toBe('200.00');
      expect(body.cmv).toBe(cmvEsperado);
      expect(body.margenBruto).toBe(
        new Prisma.Decimal('200.00').minus(cmvEsperado).toFixed(2),
      );
      expect(body.gastos).toBe('0.00');
      expect(body.periodo).toEqual({
        desde: '2031-01-05',
        hasta: '2031-01-05',
      });
      expect(body.calculadoEn).toBeDefined();
    });
  });

  describe('filtro 1 — estado de la venta (COMPLETADA)', () => {
    it('venta anulada: no aporta ni a ingresos ni a cmv', async () => {
      await abrirSesion();
      const variant = await createVariant({
        precioVenta: '90.00',
        costoActual: '50.00',
        stockActual: 10,
      });
      const venta = await crearVentaCompletada({
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '90.00',
      });
      await fijarFechaVenta(venta.saleId, new Date('2031-01-06T10:00:00.000Z'));

      await prisma.$transaction((tx) =>
        salesService.anularVenta(tx, {
          saleId: venta.saleId,
          userId: ownerId,
          esOwner: true,
        }),
      );

      const response = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2031-01-06', hasta: '2031-01-06' });

      expect(response.status).toBe(200);
      const body = response.body as ResultadosBody;
      expect(body.ingresos).toBe('0.00');
      expect(body.cmv).toBe('0.00');
    });
  });

  describe('filtro 2 — reingresaStock de la devolución', () => {
    it('devolución con reingresaStock: false: ingresos baja por totalDevuelto, cmv NO baja', async () => {
      await abrirSesion();
      const variant = await createVariant({
        precioVenta: '80.00',
        costoActual: '50.00',
        stockActual: 10,
      });
      const venta = await crearVentaCompletada({
        variantId: variant.id,
        cantidad: 2,
        montoTotal: '160.00',
      });
      await fijarFechaVenta(venta.saleId, new Date('2031-01-07T10:00:00.000Z'));

      const returnResponse = await owned(
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
      const returnId = (returnResponse.body as { id: number }).id;
      createdReturnIds.push(returnId);
      await fijarFechaDevolucion(
        returnId,
        new Date('2031-01-07T11:00:00.000Z'),
      );

      const response = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2031-01-07', hasta: '2031-01-07' });

      expect(response.status).toBe(200);
      const body = response.body as ResultadosBody;
      // ingresos = 160.00 (venta) − 80.00 (devuelto) = 80.00
      expect(body.ingresos).toBe('80.00');
      // cmv = 2 × 50.00 = 100.00, SIN restar nada de la línea devuelta
      // (reingresaStock: false — la mercadería se perdió).
      const cmvEsperado = venta.costoUnitario.times(2).toFixed(2);
      expect(body.cmv).toBe(cmvEsperado);
    });
  });

  describe('filtro 3 — estructural (fecha de cabecera, sin ajuste de hora argentina)', () => {
    it('un gasto con fecha fuera del rango consultado no aparece en gastos, aunque sí aparezca en un rango más amplio que lo cubra', async () => {
      const categoriaId = await crearCategoria(
        `Categoría filtro3 T6.4 ${randomUUID()}`,
      );
      const gastoDentro = await crearGastoDirect(
        categoriaId,
        '30.00',
        new Date('2031-01-08T12:00:00.000Z'),
      );
      const gastoFuera = await crearGastoDirect(
        categoriaId,
        '70.00',
        new Date('2031-01-20T12:00:00.000Z'),
      );
      void gastoDentro;
      void gastoFuera;

      const angosto = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2031-01-08', hasta: '2031-01-08' });
      expect(angosto.status).toBe(200);
      expect((angosto.body as ResultadosBody).gastos).toBe('30.00');

      const amplio = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2031-01-01', hasta: '2031-01-31' });
      expect(amplio.status).toBe(200);
      expect((amplio.body as ResultadosBody).gastos).toBe('100.00');
    });
  });

  // T6.5 (AD-13) — el test obligatorio de BLUEPRINT §5.6, textual: "Un
  // test debe verificar que una venta de las 23:30 pertenece al día
  // correcto." 23:30 hora argentina de un día D es UTC 02:30 del día
  // D+1 (23:30 + 3h cruza la medianoche) — sin la conversión a hora
  // argentina (el bug que T6.4 dejó pendiente a propósito), esa venta
  // caería en el `/resultados` del día D+1 (el día UTC), cuando en
  // realidad pertenece al día D (el día argentino real en que se
  // vendió). Variante/producto exclusivos de este describe (creados por
  // `createVariant`, `helpers` ya existentes) para que el rango quede
  // limpio sin depender de ningún otro fixture del archivo.
  describe('agrupación temporal en hora argentina (AD-13, T6.5) — venta de las 23:30', () => {
    it('venta a las 23:30 hora argentina del día D (UTC D+1 02:30:00) pertenece al /resultados del día D, no del día D+1 (UTC ingenuo)', async () => {
      await abrirSesion();
      const variant = await createVariant({
        precioVenta: '150.00',
        costoActual: '90.00',
        stockActual: 10,
      });
      const venta = await crearVentaCompletada({
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '150.00',
      });
      // D = '2026-07-10'. 23:30 hora argentina de D = UTC 02:30 de D+1
      // ('2026-07-11'), porque Argentina es UTC-3 (23:30 + 3h = 02:30
      // del día siguiente).
      await fijarFechaVenta(venta.saleId, new Date('2026-07-11T02:30:00.000Z'));

      // El día ARGENTINO real (D) — la venta SÍ tiene que aportar.
      const diaArgentino = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2026-07-10', hasta: '2026-07-10' });
      expect(diaArgentino.status).toBe(200);
      const bodyArgentino = diaArgentino.body as ResultadosBody;
      expect(bodyArgentino.ingresos).toBe('150.00');
      const cmvEsperado = venta.costoUnitario.toFixed(2);
      expect(bodyArgentino.cmv).toBe(cmvEsperado);

      // El día UTC "ingenuo" (D+1) — el que un cálculo sin AD-13 usaría
      // por error. La venta NO tiene que aparecer acá.
      const diaUtcIngenuo = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2026-07-11', hasta: '2026-07-11' });
      expect(diaUtcIngenuo.status).toBe(200);
      const bodyUtcIngenuo = diaUtcIngenuo.body as ResultadosBody;
      expect(bodyUtcIngenuo.ingresos).toBe('0.00');
      expect(bodyUtcIngenuo.cmv).toBe('0.00');
    });

    it('caso de control simétrico: venta a las 00:30 hora argentina del día D (UTC D 03:30:00) pertenece a D, no a D-1', async () => {
      await abrirSesion();
      const variant = await createVariant({
        precioVenta: '75.00',
        costoActual: '40.00',
        stockActual: 10,
      });
      const venta = await crearVentaCompletada({
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '75.00',
      });
      // D = '2026-07-15'. 00:30 hora argentina de D = UTC 03:30 del
      // MISMO día D (00:30 + 3h = 03:30, sin cruzar la medianoche hacia
      // atrás) — este es el lado "sin sorpresa" de la conversión, el
      // mismo criterio que el test unitario de T0.7 ("00:30 hora
      // argentina pertenece al día que arrancó").
      await fijarFechaVenta(venta.saleId, new Date('2026-07-15T03:30:00.000Z'));

      const diaD = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2026-07-15', hasta: '2026-07-15' });
      expect(diaD.status).toBe(200);
      const bodyD = diaD.body as ResultadosBody;
      expect(bodyD.ingresos).toBe('75.00');
      expect(bodyD.cmv).toBe(venta.costoUnitario.toFixed(2));

      const diaDMenos1 = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2026-07-14', hasta: '2026-07-14' });
      expect(diaDMenos1.status).toBe(200);
      const bodyDMenos1 = diaDMenos1.body as ResultadosBody;
      expect(bodyDMenos1.ingresos).toBe('0.00');
      expect(bodyDMenos1.cmv).toBe('0.00');
    });
  });

  describe('edge case — período sin ningún dato', () => {
    it('200, todos los campos en "0.00"', async () => {
      const response = await owned(
        request(app.getHttpServer()).get('/resultados'),
      ).query({ desde: '2032-12-25', hasta: '2032-12-25' });

      expect(response.status).toBe(200);
      const body = response.body as ResultadosBody;
      expect(body.ingresos).toBe('0.00');
      expect(body.cmv).toBe('0.00');
      expect(body.margenBruto).toBe('0.00');
      expect(body.margenBrutoPct).toBe('0.00');
      expect(body.gastos).toBe('0.00');
      expect(body.resultadoNeto).toBe('0.00');
    });
  });

  // ─── T6.6 — Fase 04a: tests primero, en sesión aislada ─────────────────
  // Fuente única: el ticket T6.6 pasado en el prompt de esta fase.
  // `ResultadosController`/`ResultadosService` YA registran las rutas
  // nuevas (stub de esta misma fase, `rankingProductos`/
  // `gastosPorCategoria` siempre rechazan con un Error genérico ("T6.6
  // todavía no implementado") — este bloque entero debe quedar en rojo
  // por eso (probablemente 500 en los casos que hoy deberían dar
  // 200/400), nunca por compilación. Reusa los helpers ya existentes de
  // este archivo (`abrirSesion`, `createVariant`, `crearVentaCompletada`,
  // `fijarFechaVenta`, `fijarFechaDevolucion`, `crearCategoria`,
  // `crearGastoDirect`, `owned`, `sold`) — misma estrategia
  // anti-contaminación (fechas fijas, exclusivas de cada escenario, años
  // 2033/2034 para no superponer con el resto del archivo).
  describe('GET /resultados/ranking-productos (T6.6)', () => {
    describe('autenticación y rol (RN-11 — OWNER-only)', () => {
      it('sin sesión → 401', async () => {
        await request(app.getHttpServer())
          .get('/resultados/ranking-productos')
          .query({ desde: '2033-01-01', hasta: '2033-01-01' })
          .expect(401);
      });

      it('con SELLER → 403', async () => {
        await sold(
          request(app.getHttpServer()).get('/resultados/ranking-productos'),
        )
          .query({ desde: '2033-01-01', hasta: '2033-01-01' })
          .expect(403);
      });
    });

    describe('validación', () => {
      it('desde > hasta → 400', async () => {
        const response = await owned(
          request(app.getHttpServer()).get('/resultados/ranking-productos'),
        ).query({ desde: '2033-02-15', hasta: '2033-01-01' });

        expect(response.status).toBe(400);
      });

      it('orden con un valor inválido → 400', async () => {
        const response = await owned(
          request(app.getHttpServer()).get('/resultados/ranking-productos'),
        ).query({
          desde: '2033-01-01',
          hasta: '2033-01-01',
          orden: 'no-existe',
        });

        expect(response.status).toBe(400);
      });
    });

    describe('camino feliz', () => {
      it('dos variantes con ventas reales: orden por unidades y por margen dan resultados distintos', async () => {
        await abrirSesion();
        // Variante A: 5 unidades vendidas, margen bajo (150.00).
        // Variante B: 2 unidades vendidas, margen alto (240.00) — a
        // propósito, para que el orden por "unidades" y por "margen" NO
        // coincidan.
        const variantA = await createVariant({
          precioVenta: '50.00',
          costoActual: '20.00',
          stockActual: 10,
        });
        const variantB = await createVariant({
          precioVenta: '150.00',
          costoActual: '30.00',
          stockActual: 10,
        });
        const ventaA = await crearVentaCompletada({
          variantId: variantA.id,
          cantidad: 5,
          montoTotal: '250.00',
        });
        const ventaB = await crearVentaCompletada({
          variantId: variantB.id,
          cantidad: 2,
          montoTotal: '300.00',
        });
        await fijarFechaVenta(
          ventaA.saleId,
          new Date('2033-01-05T10:00:00.000Z'),
        );
        await fijarFechaVenta(
          ventaB.saleId,
          new Date('2033-01-05T11:00:00.000Z'),
        );

        const margenA = new Prisma.Decimal('250.00')
          .minus(ventaA.costoUnitario.times(5))
          .toFixed(2);
        const margenB = new Prisma.Decimal('300.00')
          .minus(ventaB.costoUnitario.times(2))
          .toFixed(2);

        const porUnidades = await owned(
          request(app.getHttpServer()).get('/resultados/ranking-productos'),
        ).query({
          desde: '2033-01-05',
          hasta: '2033-01-05',
          orden: 'unidades',
        });
        expect(porUnidades.status).toBe(200);
        const bodyUnidades = porUnidades.body as RankingProductoItemBody[];
        expect(bodyUnidades.map((r) => r.variantId)).toEqual([
          variantA.id,
          variantB.id,
        ]);
        expect(bodyUnidades[0].unidadesVendidas).toBe(5);
        expect(bodyUnidades[0].margenTotal).toBe(margenA);
        expect(bodyUnidades[1].unidadesVendidas).toBe(2);
        expect(bodyUnidades[1].margenTotal).toBe(margenB);

        const porMargen = await owned(
          request(app.getHttpServer()).get('/resultados/ranking-productos'),
        ).query({ desde: '2033-01-05', hasta: '2033-01-05', orden: 'margen' });
        expect(porMargen.status).toBe(200);
        const bodyMargen = porMargen.body as RankingProductoItemBody[];
        expect(bodyMargen.map((r) => r.variantId)).toEqual([
          variantB.id,
          variantA.id,
        ]);
      });
    });

    describe('devolución reingresaStock: false', () => {
      it('baja unidades e ingresos (y por lo tanto el margen) de esa variante, sin tocar su costo', async () => {
        await abrirSesion();
        const variant = await createVariant({
          precioVenta: '100.00',
          costoActual: '50.00',
          stockActual: 10,
        });
        const venta = await crearVentaCompletada({
          variantId: variant.id,
          cantidad: 4,
          montoTotal: '400.00',
        });
        await fijarFechaVenta(
          venta.saleId,
          new Date('2033-01-06T10:00:00.000Z'),
        );

        const returnResponse = await owned(
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
            returnPayments: [
              { metodo: PaymentMetodo.EFECTIVO, monto: '100.00' },
            ],
          })
          .expect(201);
        const returnId = (returnResponse.body as { id: number }).id;
        createdReturnIds.push(returnId);
        await fijarFechaDevolucion(
          returnId,
          new Date('2033-01-06T11:00:00.000Z'),
        );

        const response = await owned(
          request(app.getHttpServer()).get('/resultados/ranking-productos'),
        ).query({ desde: '2033-01-06', hasta: '2033-01-06' });

        expect(response.status).toBe(200);
        const body = response.body as RankingProductoItemBody[];
        const item = body.find((r) => r.variantId === variant.id);
        expect(item).toBeDefined();
        // unidadesVendidas = 4 − 1 = 3.
        expect(item?.unidadesVendidas).toBe(3);
        // margenTotal = (400.00 − 100.00) − 4×costoUnitario — el costo
        // NO se revierte por la devolución (reingresaStock: false).
        const margenEsperado = new Prisma.Decimal('300.00')
          .minus(venta.costoUnitario.times(4))
          .toFixed(2);
        expect(item?.margenTotal).toBe(margenEsperado);
      });
    });

    describe('edge case — período sin datos', () => {
      it('200, array vacío', async () => {
        const response = await owned(
          request(app.getHttpServer()).get('/resultados/ranking-productos'),
        ).query({ desde: '2034-12-25', hasta: '2034-12-25' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
      });
    });
  });

  describe('GET /resultados/gastos-por-categoria (T6.6)', () => {
    describe('autenticación y rol (RN-11 — OWNER-only)', () => {
      it('sin sesión → 401', async () => {
        await request(app.getHttpServer())
          .get('/resultados/gastos-por-categoria')
          .query({ desde: '2033-02-01', hasta: '2033-02-01' })
          .expect(401);
      });

      it('con SELLER → 403', async () => {
        await sold(
          request(app.getHttpServer()).get(
            '/resultados/gastos-por-categoria',
          ),
        )
          .query({ desde: '2033-02-01', hasta: '2033-02-01' })
          .expect(403);
      });
    });

    describe('validación', () => {
      it('desde > hasta → 400', async () => {
        const response = await owned(
          request(app.getHttpServer()).get(
            '/resultados/gastos-por-categoria',
          ),
        ).query({ desde: '2033-02-15', hasta: '2033-02-01' });

        expect(response.status).toBe(400);
      });
    });

    describe('camino feliz', () => {
      it('dos categorías con gastos reales: ordenado descendente por total', async () => {
        const categoriaA = await crearCategoria(
          `Categoría T6.6 A ${randomUUID()}`,
        );
        const categoriaB = await crearCategoria(
          `Categoría T6.6 B ${randomUUID()}`,
        );
        await crearGastoDirect(
          categoriaA,
          '500.00',
          new Date('2033-02-01T10:00:00.000Z'),
        );
        await crearGastoDirect(
          categoriaA,
          '300.00',
          new Date('2033-02-01T11:00:00.000Z'),
        );
        await crearGastoDirect(
          categoriaB,
          '1000.00',
          new Date('2033-02-01T12:00:00.000Z'),
        );

        const response = await owned(
          request(app.getHttpServer()).get(
            '/resultados/gastos-por-categoria',
          ),
        ).query({ desde: '2033-02-01', hasta: '2033-02-01' });

        expect(response.status).toBe(200);
        const body = response.body as GastoPorCategoriaItemBody[];
        expect(body.map((c) => c.expenseCategoryId)).toEqual([
          categoriaB,
          categoriaA,
        ]);
        expect(body[0].total).toBe('1000.00');
        expect(body[1].total).toBe('800.00');
      });
    });

    describe('filtro — fecha de cabecera', () => {
      it('un gasto fuera del rango consultado no aporta al total de su categoría (aunque sí en un rango más amplio)', async () => {
        const categoria = await crearCategoria(
          `Categoría T6.6 filtro ${randomUUID()}`,
        );
        await crearGastoDirect(
          categoria,
          '30.00',
          new Date('2033-02-08T12:00:00.000Z'),
        );
        await crearGastoDirect(
          categoria,
          '70.00',
          new Date('2033-02-20T12:00:00.000Z'),
        );

        const angosto = await owned(
          request(app.getHttpServer()).get(
            '/resultados/gastos-por-categoria',
          ),
        ).query({ desde: '2033-02-08', hasta: '2033-02-08' });
        expect(angosto.status).toBe(200);
        const bodyAngosto = angosto.body as GastoPorCategoriaItemBody[];
        expect(bodyAngosto).toEqual([
          { expenseCategoryId: categoria, nombre: expect.any(String), total: '30.00' },
        ]);

        const amplio = await owned(
          request(app.getHttpServer()).get(
            '/resultados/gastos-por-categoria',
          ),
        ).query({ desde: '2033-02-01', hasta: '2033-02-28' });
        expect(amplio.status).toBe(200);
        const bodyAmplio = amplio.body as GastoPorCategoriaItemBody[];
        expect(bodyAmplio).toEqual([
          { expenseCategoryId: categoria, nombre: expect.any(String), total: '100.00' },
        ]);
      });
    });

    describe('edge case — período sin datos', () => {
      it('200, array vacío', async () => {
        const response = await owned(
          request(app.getHttpServer()).get(
            '/resultados/gastos-por-categoria',
          ),
        ).query({ desde: '2034-12-26', hasta: '2034-12-26' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual([]);
      });
    });
  });
});
