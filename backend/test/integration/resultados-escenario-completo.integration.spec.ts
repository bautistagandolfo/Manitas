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

// ─── T6.7 — Escenario completo calculado a mano ─────────────────────────
//
// A diferencia de todos los tests de `resultados.integration.spec.ts`
// (T6.4/T6.5/T6.6), este archivo NO se escribió mirando
// `resultados.service.ts` ni `resultados.controller.ts` — ni antes ni
// después de calcular. Fuente única de la fórmula: BLUEPRINT §5.6
// (pegada textual en el prompt de esta fase) más las reglas de negocio ya
// conocidas (invariantes 11/12, AD-7, AD-13). El cálculo a mano completo
// está en el bloque de comentario grande antes de los `expect`, más abajo.
//
// SÍ se usó como referencia MECÁNICA (nunca como fuente de fórmula ni de
// "qué esperaban los tests anteriores"): `sales.integration.spec.ts` (forma
// del input de `salesService.crearVenta` con múltiples líneas),
// `sales-anulacion.integration.spec.ts` (cómo invocar
// `salesService.anularVenta(tx, { saleId, userId, esOwner })`),
// `returns.integration.spec.ts`/`returns-controller.integration.spec.ts`
// (forma del body de `POST /returns`: `items[].reingresaStock`,
// `returnPayments`), `cash-registers.integration.spec.ts` (apertura de
// sesión) y la ESTRUCTURA MECÁNICA (helpers, patrón de limpieza en
// `afterAll`, cookies de auth) de `resultados.integration.spec.ts` — nunca
// sus valores esperados.
//
// Año exclusivo 2036 (confirmado con grep antes de empezar que ningún otro
// test de `resultados*` lo usa) para que no haya contaminación cruzada con
// otros fixtures del módulo. Todos los eventos "en período" caen dentro
// del día argentino 2036-05-04 (horarios de media mañana/tarde en UTC,
// lejos de cualquier borde de medianoche — ese borde ya está cubierto por
// T6.5, no es el objetivo de este archivo). El dato de control cae en
// 2036-05-10, un día completamente distinto.

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
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

describe('resultados — escenario completo calculado a mano (integration, T6.7)', () => {
  let app: INestApplication<App>;
  let salesService: SalesService;
  let ownerCookie: string;
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

  async function abrirSesion(montoInicial = '5000.00'): Promise<number> {
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
    nombreProducto: string,
    overrides: { precioVenta: string; costoActual: string },
  ): Promise<{ id: number }> {
    const product = await prisma.product.create({
      data: { nombre: `${nombreProducto} (T6.7 ${randomUUID()})` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `T6.7-${randomUUID()}`,
        precioVenta: new Prisma.Decimal(overrides.precioVenta),
        costoActual: new Prisma.Decimal(overrides.costoActual),
        stockActual: 20,
        activo: true,
      },
    });
    createdVariantIds.push(variant.id);
    return { id: variant.id };
  }

  // Venta real vía `POST /sales`, con una o varias líneas — a diferencia
  // del helper de una sola línea de `resultados.integration.spec.ts`, este
  // escenario necesita una venta con DOS líneas de variantes distintas
  // (venta 1). Devuelve, por cada línea, el `saleItemId` y el
  // `costoUnitario` REALES que `sales` congeló (AD-5) — nunca inventados.
  async function crearVentaCompletada(
    items: Array<{ variantId: number; cantidad: number }>,
    montoTotal: string,
  ): Promise<{
    saleId: number;
    items: Array<{
      saleItemId: number;
      variantId: number;
      costoUnitario: Prisma.Decimal;
    }>;
  }> {
    const response = await owned(request(app.getHttpServer()).post('/sales'))
      .set('Idempotency-Key', randomUUID())
      .send({
        items,
        payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: montoTotal }],
      })
      .expect(201);

    const body = response.body as { id: number };
    createdSaleIds.push(body.id);

    const saleItems = await prisma.saleItem.findMany({
      where: { saleId: body.id },
      orderBy: { id: 'asc' },
    });

    return {
      saleId: body.id,
      items: saleItems.map((si) => ({
        saleItemId: si.id,
        variantId: si.variantId,
        costoUnitario: si.costoUnitario,
      })),
    };
  }

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
      data: { nombre: `${nombre} (T6.7 ${randomUUID()})` },
    });
    createdCategoryIds.push(categoria.id);
    return categoria.id;
  }

  // Gasto insertado directo por Prisma (mismo precedente ya establecido en
  // `resultados.integration.spec.ts`, `crearGastoDirect`): permite fijar
  // `fecha` con precisión exacta. El `medioPago` no entra en la fórmula de
  // BLUEPRINT §5.6 (`Gastos = SUM(expenses.monto)`, sin distinguir medio
  // de pago) — se fija igual, correcto, por fidelidad narrativa del
  // escenario (un gasto en efectivo real de la tienda necesita una sesión
  // de caja abierta en el momento en que ocurre; uno por transferencia,
  // no).
  async function crearGastoDirect(
    categoryId: number,
    monto: string,
    fecha: Date,
    medioPago: ExpenseMedioPago,
  ): Promise<number> {
    const expense = await prisma.expense.create({
      data: {
        fecha,
        expenseCategoryId: categoryId,
        descripcion: 'Gasto de prueba (T6.7, escenario completo)',
        monto: new Prisma.Decimal(monto),
        medioPago,
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
        email: `resultados-t67-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (T6.7, escenario completo)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    ownerId = owner.id;
    createdUserIds.push(owner.id);

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: 'password123' })
      .expect(200);
    ownerCookie = extractCookie(ownerLogin.headers['set-cookie']);
  });

  afterAll(async () => {
    await closeAnyOpenSessionDirect();

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

  it('escenario de un día de la tienda: dos ventas, una anulación, dos devoluciones (con y sin reingresaStock), gastos en efectivo y transferencia, y un dato de control fuera de rango', async () => {
    // ─── Setup del escenario ────────────────────────────────────────────
    // Toda la actividad "real" del día ocurre dentro de UNA sola sesión de
    // caja, abierta al principio y nunca cerrada hasta el `afterAll` — la
    // fecha de cada fila se fija después, directo por Prisma, así que la
    // sesión real en la que se creó cada fila es irrelevante para el
    // cálculo (mismo criterio ya usado por `resultados.integration.spec.ts`).
    await abrirSesion();

    // Variantes propias del escenario, con precio y costo congelado
    // (AD-5) claramente distintos entre sí.
    const variantRemera = await createVariant('Remera básica', {
      precioVenta: '100.00',
      costoActual: '40.00',
    });
    const variantPantalon = await createVariant('Pantalón cargo', {
      precioVenta: '200.00',
      costoActual: '90.00',
    });
    const variantBuzo = await createVariant('Buzo canguro', {
      precioVenta: '150.00',
      costoActual: '70.00',
    });
    // Variante exclusiva de la venta que se va a anular — nunca debería
    // aportar nada a ninguna de las tres respuestas.
    const variantCampera = await createVariant('Campera de jean', {
      precioVenta: '250.00',
      costoActual: '100.00',
    });
    // Variante exclusiva del dato de control fuera de rango.
    const variantGorra = await createVariant('Gorra', {
      precioVenta: '80.00',
      costoActual: '30.00',
    });

    // Venta 1 (COMPLETADA): una clienta se lleva 3 remeras y 1 pantalón en
    // el mismo ticket. Dos líneas, dos variantes distintas.
    // Remera:   3 × $100.00 = $300.00 (costo congelado 3 × $40.00 = $120.00)
    // Pantalón: 1 × $200.00 = $200.00 (costo congelado 1 × $90.00 = $90.00)
    // Total venta 1 = $500.00
    const venta1 = await crearVentaCompletada(
      [
        { variantId: variantRemera.id, cantidad: 3 },
        { variantId: variantPantalon.id, cantidad: 1 },
      ],
      '500.00',
    );
    await fijarFechaVenta(venta1.saleId, new Date('2036-05-04T13:00:00.000Z'));
    const itemRemeraV1 = venta1.items.find(
      (i) => i.variantId === variantRemera.id,
    )!;

    // Venta 2 (COMPLETADA): otro cliente se lleva 4 buzos.
    // Buzo: 4 × $150.00 = $600.00 (costo congelado 4 × $70.00 = $280.00)
    // Total venta 2 = $600.00
    const venta2 = await crearVentaCompletada(
      [{ variantId: variantBuzo.id, cantidad: 4 }],
      '600.00',
    );
    await fijarFechaVenta(venta2.saleId, new Date('2036-05-04T14:00:00.000Z'));
    const itemBuzoV2 = venta2.items[0];

    // Venta 3 (creada y luego ANULADA): un error de caja — se cobró una
    // campera de más y se anula en el momento. No tiene que aportar NADA a
    // ninguna de las tres respuestas, ni siquiera estando fechada DENTRO
    // del período (a diferencia del dato de control, que queda afuera por
    // FECHA — acá la exclusión es por ESTADO).
    // Campera: 2 × $250.00 = $500.00 (costo congelado 2 × $100.00 = $200.00)
    const venta3 = await crearVentaCompletada(
      [{ variantId: variantCampera.id, cantidad: 2 }],
      '500.00',
    );
    await fijarFechaVenta(venta3.saleId, new Date('2036-05-04T15:00:00.000Z'));
    await prisma.$transaction((tx) =>
      salesService.anularVenta(tx, {
        saleId: venta3.saleId,
        userId: ownerId,
        esOwner: true,
      }),
    );

    // Devolución 1 (reingresaStock: true) — la clienta de la venta 1
    // devuelve 1 de las 3 remeras, en buen estado, y se reintegra en
    // efectivo. Resta ingreso Y costo.
    // netoLinea devuelto = 1 × $100.00 = $100.00 (misma unidad de precio
    // que la línea original, sin descuento de por medio).
    const returnResponse1 = await owned(
      request(app.getHttpServer()).post('/returns'),
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        saleId: venta1.saleId,
        tipo: ReturnTipo.DEVOLUCION,
        items: [
          {
            saleItemId: itemRemeraV1.saleItemId,
            cantidad: 1,
            reingresaStock: true,
          },
        ],
        returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '100.00' }],
      })
      .expect(201);
    const return1Id = (returnResponse1.body as { id: number }).id;
    createdReturnIds.push(return1Id);
    await fijarFechaDevolucion(return1Id, new Date('2036-05-04T16:00:00.000Z'));

    // Devolución 2 (reingresaStock: false) — de la venta 2, 2 de los 4
    // buzos vuelven falladas (no se pueden revender) y también se
    // reintegra el dinero. Resta ingreso, el costo NO se revierte.
    // netoLinea devuelto = 2 × $150.00 = $300.00.
    const returnResponse2 = await owned(
      request(app.getHttpServer()).post('/returns'),
    )
      .set('Idempotency-Key', randomUUID())
      .send({
        saleId: venta2.saleId,
        tipo: ReturnTipo.DEVOLUCION,
        items: [
          {
            saleItemId: itemBuzoV2.saleItemId,
            cantidad: 2,
            reingresaStock: false,
          },
        ],
        returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '300.00' }],
      })
      .expect(201);
    const return2Id = (returnResponse2.body as { id: number }).id;
    createdReturnIds.push(return2Id);
    await fijarFechaDevolucion(return2Id, new Date('2036-05-04T17:00:00.000Z'));

    // Gasto en efectivo — se paga un pedido de insumos de limpieza con la
    // plata del cajón, con la sesión de caja del día abierta.
    const categoriaInsumos = await crearCategoria('Insumos de limpieza');
    await crearGastoDirect(
      categoriaInsumos,
      '150.00',
      new Date('2036-05-04T18:00:00.000Z'),
      ExpenseMedioPago.EFECTIVO,
    );

    // Gasto por transferencia — el alquiler del local, pagado directo
    // desde la cuenta del negocio, sin pasar por la caja física.
    const categoriaAlquiler = await crearCategoria('Alquiler');
    await crearGastoDirect(
      categoriaAlquiler,
      '800.00',
      new Date('2036-05-04T19:00:00.000Z'),
      ExpenseMedioPago.TRANSFERENCIA,
    );

    // ─── Datos de control, fuera del período consultado (2036-05-10) ────
    // Una venta y un gasto reales, bien formados, que solo difieren de
    // todo lo de arriba en la fecha — confirman que el filtro de fecha
    // (no el de estado) es lo que los deja afuera.
    const ventaControl = await crearVentaCompletada(
      [{ variantId: variantGorra.id, cantidad: 1 }],
      '80.00',
    );
    await fijarFechaVenta(
      ventaControl.saleId,
      new Date('2036-05-10T13:00:00.000Z'),
    );

    await crearGastoDirect(
      categoriaAlquiler,
      '300.00',
      new Date('2036-05-10T14:00:00.000Z'),
      ExpenseMedioPago.OTRO,
    );

    // ╔══════════════════════════════════════════════════════════════════╗
    // ║ CÁLCULO A MANO (BLUEPRINT §5.6, sin mirar resultados.service.ts) ║
    // ╚══════════════════════════════════════════════════════════════════╝
    //
    // Período consultado: 2036-05-04 (un solo día argentino). Todos los
    // eventos "en período" de arriba están fechados entre las 13:00 y las
    // 19:00 UTC de ese mismo día (10:00–16:00 hora argentina, lejos de
    // cualquier borde de medianoche). Venta 3 (ANULADA) también cae en
    // este rango de fecha — a propósito, para probar que la excluye el
    // filtro de ESTADO, no el de fecha. Los dos eventos de control caen
    // en 2036-05-10, un día totalmente distinto.
    //
    // INGRESOS = SUM(sales.total, estado=COMPLETADA, en período)
    //          − SUM(returns.total_devuelto, en período)
    //
    //   Ventas COMPLETADA en período:
    //     venta1.total = $500.00
    //     venta2.total = $600.00
    //     (venta3 excluida: ANULADA. ventaControl excluida: fuera de
    //     fecha.)
    //     SUM(sales.total) = $500.00 + $600.00 = $1100.00
    //
    //   Devoluciones en período:
    //     return1.totalDevuelto = $100.00
    //     return2.totalDevuelto = $300.00
    //     SUM(returns.total_devuelto) = $100.00 + $300.00 = $400.00
    //
    //   INGRESOS = $1100.00 − $400.00 = $700.00
    //
    // CMV = SUM(sale_items.cantidad × costo_unitario, JOIN sales
    //         estado=COMPLETADA, en período)
    //     − SUM(return_items.cantidad × costo_unitario,
    //         reingresa_stock=true, en período)
    //
    //   Líneas de venta COMPLETADA en período:
    //     venta1/remera:   3 × $40.00 = $120.00
    //     venta1/pantalón: 1 × $90.00 = $90.00
    //     venta2/buzo:     4 × $70.00 = $280.00
    //     (venta3/campera excluida: la venta está ANULADA.)
    //     SUM(sale_items) = $120.00 + $90.00 + $280.00 = $490.00
    //
    //   Líneas de devolución con reingresaStock=true en período:
    //     return1/remera: 1 × $40.00 = $40.00 (reingresaStock: true)
    //     (return2/buzo NO cuenta acá: reingresaStock: false — el costo
    //     de esas 2 unidades falladas se perdió, sigue siendo CMV.)
    //     SUM(return_items reingresaStock=true) = $40.00
    //
    //   CMV = $490.00 − $40.00 = $450.00
    //
    // MARGEN BRUTO = INGRESOS − CMV = $700.00 − $450.00 = $250.00
    //
    // MARGEN BRUTO % = MARGEN BRUTO / INGRESOS × 100
    //                = $250.00 / $700.00 × 100
    //                = 35.714285714...%
    //                → ROUND_HALF_UP a 2 decimales = 35.71%
    //                (el 3er decimal es 4, redondea hacia abajo)
    //
    // GASTOS = SUM(expenses.monto, en período)
    //   Gasto efectivo (Insumos de limpieza): $150.00
    //   Gasto transferencia (Alquiler):       $800.00
    //   (gasto control de $300.00 excluido: fuera de fecha.)
    //   GASTOS = $150.00 + $800.00 = $950.00
    //
    // RESULTADO NETO = MARGEN BRUTO − GASTOS
    //                = $250.00 − $950.00 = −$700.00
    //
    // ── Ranking de productos (RN-10, mismos filtros que RN-8 por
    //    variante): unidades e ingresos restan TODA devolución (con o sin
    //    reingresaStock); el costo (y por lo tanto el margen) solo se
    //    revierte si reingresaStock=true. margenTotal = ingresos − cmv,
    //    por variante.
    //
    //   Remera (venta1, devuelta parcialmente con reingresaStock=true):
    //     unidadesVendidas = 3 (vendidas) − 1 (devuelta) = 2
    //     ingresos = $300.00 (línea) − $100.00 (devuelto) = $200.00
    //     cmv      = $120.00 (línea) − $40.00 (revertido) = $80.00
    //     margenTotal = $200.00 − $80.00 = $120.00
    //
    //   Pantalón (venta1, sin devoluciones):
    //     unidadesVendidas = 1
    //     ingresos = $200.00
    //     cmv      = $90.00
    //     margenTotal = $200.00 − $90.00 = $110.00
    //
    //   Buzo (venta2, devuelto parcialmente con reingresaStock=false):
    //     unidadesVendidas = 4 (vendidas) − 2 (devueltas) = 2
    //     ingresos = $600.00 (línea) − $300.00 (devuelto) = $300.00
    //     cmv      = $280.00 (línea, SIN reversión: reingresaStock=false)
    //     margenTotal = $300.00 − $280.00 = $20.00
    //
    //   Campera (venta3, ANULADA): no aparece en el ranking.
    //   Gorra (ventaControl, fuera de rango): no aparece en el ranking.
    //
    //   Orden por unidades (desc, empate por variantId asc):
    //     Remera = 2, Buzo = 2 (empate → Remera primero: variantId menor,
    //     se creó antes que Buzo), Pantalón = 1.
    //     → [Remera, Buzo, Pantalón]
    //
    //   Orden por margen (desc, sin empates):
    //     Remera = $120.00, Pantalón = $110.00, Buzo = $20.00.
    //     → [Remera, Pantalón, Buzo]
    //
    // ── Gastos por categoría (SUM(expenses.monto) agrupado por
    //    categoría, en el período, desc por total, empate por nombre asc):
    //     Alquiler:             $800.00
    //     Insumos de limpieza:  $150.00
    //     → [Alquiler, Insumos de limpieza]
    //     (el gasto control de $300.00 de Alquiler, fuera de rango, no
    //     suma acá — Alquiler sigue en $800.00, no $1100.00.)

    // ─── GET /resultados ──────────────────────────────────────────────
    const resultadosResponse = await owned(
      request(app.getHttpServer()).get('/resultados'),
    ).query({ desde: '2036-05-04', hasta: '2036-05-04' });

    expect(resultadosResponse.status).toBe(200);
    const resultados = resultadosResponse.body as ResultadosBody;
    expect(resultados.ingresos).toBe('700.00');
    expect(resultados.cmv).toBe('450.00');
    expect(resultados.margenBruto).toBe('250.00');
    expect(resultados.margenBrutoPct).toBe('35.71');
    expect(resultados.gastos).toBe('950.00');
    expect(resultados.resultadoNeto).toBe('-700.00');

    // ─── GET /resultados/ranking-productos ──────────────────────────────
    const rankingUnidadesResponse = await owned(
      request(app.getHttpServer()).get('/resultados/ranking-productos'),
    ).query({ desde: '2036-05-04', hasta: '2036-05-04', orden: 'unidades' });

    expect(rankingUnidadesResponse.status).toBe(200);
    const rankingUnidades =
      rankingUnidadesResponse.body as RankingProductoItemBody[];

    // Ni la campera (venta anulada) ni la gorra (fuera de rango) aparecen
    // en ningún ranking.
    expect(
      rankingUnidades.find((r) => r.variantId === variantCampera.id),
    ).toBeUndefined();
    expect(
      rankingUnidades.find((r) => r.variantId === variantGorra.id),
    ).toBeUndefined();

    expect(rankingUnidades.map((r) => r.variantId)).toEqual([
      variantRemera.id,
      variantBuzo.id,
      variantPantalon.id,
    ]);
    expect(rankingUnidades[0].unidadesVendidas).toBe(2);
    expect(rankingUnidades[0].margenTotal).toBe('120.00');
    expect(rankingUnidades[1].unidadesVendidas).toBe(2);
    expect(rankingUnidades[1].margenTotal).toBe('20.00');
    expect(rankingUnidades[2].unidadesVendidas).toBe(1);
    expect(rankingUnidades[2].margenTotal).toBe('110.00');

    const rankingMargenResponse = await owned(
      request(app.getHttpServer()).get('/resultados/ranking-productos'),
    ).query({ desde: '2036-05-04', hasta: '2036-05-04', orden: 'margen' });

    expect(rankingMargenResponse.status).toBe(200);
    const rankingMargen =
      rankingMargenResponse.body as RankingProductoItemBody[];
    expect(rankingMargen.map((r) => r.variantId)).toEqual([
      variantRemera.id,
      variantPantalon.id,
      variantBuzo.id,
    ]);
    expect(rankingMargen.map((r) => r.margenTotal)).toEqual([
      '120.00',
      '110.00',
      '20.00',
    ]);

    // ─── GET /resultados/gastos-por-categoria ────────────────────────────
    const gastosPorCategoriaResponse = await owned(
      request(app.getHttpServer()).get('/resultados/gastos-por-categoria'),
    ).query({ desde: '2036-05-04', hasta: '2036-05-04' });

    expect(gastosPorCategoriaResponse.status).toBe(200);
    const gastosPorCategoria =
      gastosPorCategoriaResponse.body as GastoPorCategoriaItemBody[];

    expect(gastosPorCategoria.map((g) => g.expenseCategoryId)).toEqual([
      categoriaAlquiler,
      categoriaInsumos,
    ]);
    expect(gastosPorCategoria[0].total).toBe('800.00');
    expect(gastosPorCategoria[1].total).toBe('150.00');

    // El gasto de control ($300.00, misma categoría Alquiler pero fuera de
    // rango) no infla el total de Alquiler del período consultado.
    const alquilerDelPeriodo = gastosPorCategoria.find(
      (g) => g.expenseCategoryId === categoriaAlquiler,
    )!;
    expect(alquilerDelPeriodo.total).toBe('800.00');

    // ─── Control fuera de rango: nada de lo de 2036-05-10 aparece en un
    //     rango que no lo cubre (ya verificado arriba para el ranking) —
    //     acá se confirma además para /resultados y para el desglose de
    //     gastos consultando específicamente ESE día.
    const controlResponse = await owned(
      request(app.getHttpServer()).get('/resultados'),
    ).query({ desde: '2036-05-10', hasta: '2036-05-10' });
    expect(controlResponse.status).toBe(200);
    const controlBody = controlResponse.body as ResultadosBody;
    expect(controlBody.ingresos).toBe('80.00');
    expect(controlBody.cmv).toBe('30.00');
    expect(controlBody.gastos).toBe('300.00');
  });
});
