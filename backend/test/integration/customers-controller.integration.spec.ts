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
  ReturnTipo,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';

// Ticket nuevo (post Release Candidate, BLUEPRINT §8.4) — "Tabla customers
// y un FK opcional en sales. Es aditivo, sin migración de datos." Pedido
// directo del usuario: registrar el saldo a favor de una devolución
// atado a una persona (DNI, distingue "dos Carlos Martínez"), en vez de
// depender de que alguien anote a mano el número de comprobante (T5.8,
// AMB-16 — el mecanismo de crédito en sí no cambia). Mismo harness que
// `returns-controller.integration.spec.ts` (fixtures propias vía Prisma
// directo, cookies de sesión, limpieza total en `afterAll`).

const prisma = new PrismaClient();

function extractCookie(setCookieHeader: unknown): string {
  const cookies = setCookieHeader as string[];
  return cookies[0].split(';')[0];
}

interface CustomerBody {
  id: number;
  nombre: string;
  dni: string;
  telefono: string | null;
}

interface ReturnResponseBody {
  id: number;
  numero: number;
  saleId: number;
  saleNuevaId: number | null;
}

interface CreditoPorReturnBody {
  returnId: number;
  numero: number;
  creditoDisponible: string | number;
}

describe('customers-controller (integration, ticket nuevo post Release Candidate)', () => {
  let app: INestApplication<App>;
  let ownerCookie: string;

  const createdUserIds: number[] = [];
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];
  const createdSessionIds: number[] = [];
  const createdSaleIds: number[] = [];
  const createdReturnIds: number[] = [];
  const createdCustomerIds: number[] = [];

  function owned(req: request.Test): request.Test {
    return req.set('Cookie', ownerCookie);
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

  async function abrirSesion(montoInicial = '1000.00'): Promise<number> {
    const response = await owned(
      request(app.getHttpServer()).post('/cash-registers/sessions'),
    )
      .send({ montoInicial })
      .expect(201);
    const body = response.body as { id: number };
    createdSessionIds.push(body.id);
    return body.id;
  }

  async function createVariant(
    overrides: { precioVenta?: string; stockActual?: number } = {},
  ): Promise<{ id: number }> {
    const product = await prisma.product.create({
      data: { nombre: `Producto test customers ${randomUUID()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `CUSTOMERS-${randomUUID()}`,
        precioVenta: new Prisma.Decimal(overrides.precioVenta ?? '100.00'),
        costoActual: new Prisma.Decimal('60.00'),
        stockActual: overrides.stockActual ?? 10,
        activo: true,
      },
    });
    createdVariantIds.push(variant.id);
    return { id: variant.id };
  }

  async function crearVentaSimple(opts: {
    variantId: number;
    cantidad: number;
    montoTotal: string;
  }): Promise<{ saleId: number; numero: number; saleItemId: number }> {
    const response = await owned(request(app.getHttpServer()).post('/sales'))
      .set('Idempotency-Key', randomUUID())
      .send({
        items: [{ variantId: opts.variantId, cantidad: opts.cantidad }],
        payments: [{ metodo: PaymentMetodo.EFECTIVO, monto: opts.montoTotal }],
      })
      .expect(201);
    const body = response.body as { id: number; numero: number };
    createdSaleIds.push(body.id);
    const saleItem = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: body.id },
      orderBy: { id: 'asc' },
    });
    return { saleId: body.id, numero: body.numero, saleItemId: saleItem.id };
  }

  async function crearCliente(overrides: {
    nombre?: string;
    dni?: string;
  } = {}): Promise<CustomerBody> {
    const response = await owned(request(app.getHttpServer()).post('/customers'))
      .send({
        nombre: overrides.nombre ?? 'Carlos Martínez',
        dni: overrides.dni ?? String(10000000 + Math.floor(Math.random() * 9000000)),
      })
      .expect(201);
    const body = response.body as CustomerBody;
    createdCustomerIds.push(body.id);
    return body;
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
        email: `customers-controller-test-owner-${Date.now()}@manitas.local`,
        passwordHash,
        nombre: 'Owner de prueba (customers controller)',
        rol: UserRole.OWNER,
        activo: true,
      },
    });
    createdUserIds.push(owner.id);

    const ownerLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: owner.email, password: 'password123' })
      .expect(200);
    ownerCookie = extractCookie(ownerLogin.headers['set-cookie']);
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
      await prisma.return.deleteMany({ where: { id: { in: createdReturnIds } } });
    }
    if (createdSaleIds.length > 0) {
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
      await prisma.variant.deleteMany({ where: { id: { in: createdVariantIds } } });
    }
    if (createdProductIds.length > 0) {
      await prisma.product.deleteMany({ where: { id: { in: createdProductIds } } });
    }
    if (createdCustomerIds.length > 0) {
      await prisma.customer.deleteMany({
        where: { id: { in: createdCustomerIds } },
      });
    }
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }

    await app.close();
    await prisma.$disconnect();
  });

  describe('POST /customers', () => {
    it('crea un cliente con nombre y DNI', async () => {
      const cliente = await crearCliente({ nombre: 'Ana Gómez', dni: '30111222' });
      expect(cliente.nombre).toBe('Ana Gómez');
      expect(cliente.dni).toBe('30111222');
    });

    it('normaliza el DNI (saca puntos) antes de guardar', async () => {
      const response = await owned(request(app.getHttpServer()).post('/customers'))
        .send({ nombre: 'Puntos Test', dni: '30.222.333' })
        .expect(201);
      const body = response.body as CustomerBody;
      createdCustomerIds.push(body.id);
      expect(body.dni).toBe('30222333');
    });

    // Motivo explícito del ticket: "puede haber dos Carlos Martínez" —
    // el DNI es lo que distingue, así que dos altas con el mismo DNI
    // (aunque el nombre difiera) tienen que rechazarse.
    it('rechaza un segundo cliente con el mismo DNI, aunque el nombre sea distinto', async () => {
      await crearCliente({ nombre: 'Carlos Martínez', dni: '30333444' });

      await owned(request(app.getHttpServer()).post('/customers'))
        .send({ nombre: 'Carlos Martínez (otro)', dni: '30.333.444' })
        .expect(409);
    });

    it('rechaza un DNI con letras o de largo inválido', async () => {
      await owned(request(app.getHttpServer()).post('/customers'))
        .send({ nombre: 'DNI inválido', dni: 'abc123' })
        .expect(400);
      await owned(request(app.getHttpServer()).post('/customers'))
        .send({ nombre: 'DNI inválido', dni: '123' })
        .expect(400);
    });

    it('rechaza sin autenticar', async () => {
      await request(app.getHttpServer())
        .post('/customers')
        .send({ nombre: 'X', dni: '12345678' })
        .expect(401);
    });
  });

  describe('GET /customers', () => {
    it('busca por nombre (insensible a mayúsculas)', async () => {
      const cliente = await crearCliente({
        nombre: 'María Rodríguez Búsqueda',
        dni: '30444555',
      });

      const response = await owned(
        request(app.getHttpServer()).get('/customers?q=rodríguez búsqueda'),
      ).expect(200);
      const body = response.body as CustomerBody[];
      expect(body.some((c) => c.id === cliente.id)).toBe(true);
    });

    it('busca por DNI, con o sin puntos', async () => {
      const cliente = await crearCliente({ nombre: 'Busca DNI', dni: '30555666' });

      const response = await owned(
        request(app.getHttpServer()).get('/customers?q=30.555.666'),
      ).expect(200);
      const body = response.body as CustomerBody[];
      expect(body.some((c) => c.id === cliente.id)).toBe(true);
    });
  });

  describe('GET /customers/:id/credito — el pedido original: saldo a favor sin depender de una anotación manual', () => {
    it('devolución simple con crédito atada a un cliente: aparece en su lista con el monto correcto', async () => {
      await abrirSesion();
      const cliente = await crearCliente();
      const variant = await createVariant({ precioVenta: '180.00' });
      const venta = await crearVentaSimple({
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '180.00',
      });

      const returnResponse = await owned(
        request(app.getHttpServer()).post('/returns'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          customerId: cliente.id,
          items: [
            { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [
            { metodo: PaymentMetodo.CREDITO_DEVOLUCION, monto: '180.00' },
          ],
        })
        .expect(201);
      const returnBody = returnResponse.body as ReturnResponseBody;
      createdReturnIds.push(returnBody.id);

      const creditoResponse = await owned(
        request(app.getHttpServer()).get(`/customers/${cliente.id}/credito`),
      ).expect(200);
      const credito = creditoResponse.body as CreditoPorReturnBody[];

      expect(credito).toHaveLength(1);
      expect(credito[0].returnId).toBe(returnBody.id);
      expect(credito[0].numero).toBe(returnBody.numero);
      expect(Number(credito[0].creditoDisponible)).toBeCloseTo(180, 2);
    });

    it('una vez consumido el crédito en una venta futura (por returnId, sin buscar el número a mano), desaparece de la lista del cliente', async () => {
      await abrirSesion();
      const cliente = await crearCliente();
      const variant = await createVariant({ precioVenta: '90.00' });
      const venta = await crearVentaSimple({
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
          customerId: cliente.id,
          items: [
            { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [
            { metodo: PaymentMetodo.CREDITO_DEVOLUCION, monto: '90.00' },
          ],
        })
        .expect(201);
      const returnBody = returnResponse.body as ReturnResponseBody;
      createdReturnIds.push(returnBody.id);

      // Venta futura y separada, pagada con ese crédito — mismo mecanismo
      // de siempre (T5.8), solo que el cliente lo encontró por su nombre
      // en vez de por el número de la devolución.
      const variantNueva = await createVariant({ precioVenta: '90.00' });
      const nuevaVentaResponse = await owned(
        request(app.getHttpServer()).post('/sales'),
      )
        .set('Idempotency-Key', randomUUID())
        .send({
          items: [{ variantId: variantNueva.id, cantidad: 1 }],
          payments: [
            {
              metodo: PaymentMetodo.CREDITO_DEVOLUCION,
              monto: '90.00',
              returnId: returnBody.id,
            },
          ],
        })
        .expect(201);
      createdSaleIds.push((nuevaVentaResponse.body as { id: number }).id);

      const creditoResponse = await owned(
        request(app.getHttpServer()).get(`/customers/${cliente.id}/credito`),
      ).expect(200);
      expect(creditoResponse.body as CreditoPorReturnBody[]).toEqual([]);
    });

    it('rechaza un cliente inexistente con 404', async () => {
      await owned(request(app.getHttpServer()).get('/customers/999999999/credito')).expect(404);
    });
  });

  describe('POST /returns con customerId', () => {
    it('rechaza un customerId inexistente sin crear nada', async () => {
      await abrirSesion();
      const variant = await createVariant({ precioVenta: '50.00' });
      const venta = await crearVentaSimple({
        variantId: variant.id,
        cantidad: 1,
        montoTotal: '50.00',
      });

      await owned(request(app.getHttpServer()).post('/returns'))
        .set('Idempotency-Key', randomUUID())
        .send({
          saleId: venta.saleId,
          tipo: ReturnTipo.DEVOLUCION,
          customerId: 999999999,
          items: [
            { saleItemId: venta.saleItemId, cantidad: 1, reingresaStock: true },
          ],
          returnPayments: [{ metodo: PaymentMetodo.EFECTIVO, monto: '50.00' }],
        })
        .expect(404);

      const devoluciones = await prisma.return.findMany({
        where: { saleId: venta.saleId },
      });
      expect(devoluciones).toHaveLength(0);
    });
  });
});
