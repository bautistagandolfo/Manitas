import { Prisma, PrismaClient, StockMovementTipo } from '@prisma/client';
import { PrismaService } from '../../src/prisma/prisma.service';
import { StockService } from '../../src/modules/stock/stock.service';

// Fase 04a (T2.4) — tests de integración escritos ANTES de la
// implementación, contra Postgres real (nunca mockeado, BLUEPRINT §9.8).
// `stock.service.ts` no tiene controller propio en este ticket: se
// instancia directamente y se le pasa el `tx` de una transacción abierta
// acá mismo, igual que lo va a hacer quien lo llame de verdad (`sales`,
// los controllers de T2.5/T2.6) — contrato de la sección 4.2 de
// `state/reports/modulo-products-variants-spec.md`.
//
// Todo el stock de prueba se siembra a través del propio `StockService`
// (nunca escribiendo `stock_actual` a mano vía Prisma) — es exactamente
// el invariante que este archivo verifica (AD-4 / invariante 1: escribir
// `stock_actual` directo lo rompería desde la semilla misma).

const prisma = new PrismaClient();
const service = new StockService(prisma as unknown as PrismaService);

async function sumMovementDeltas(variantId: number): Promise<number> {
  const result = await prisma.stockMovement.aggregate({
    where: { variantId },
    _sum: { delta: true },
  });
  return result._sum.delta ?? 0;
}

describe('StockService (integration)', () => {
  let userId: number;
  const createdProductIds: number[] = [];
  const createdVariantIds: number[] = [];

  async function createTestVariant(
    costoActualInicial = '5.00',
  ): Promise<number> {
    const product = await prisma.product.create({
      data: { nombre: `Producto Stock Test ${Date.now()}-${Math.random()}` },
    });
    createdProductIds.push(product.id);

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: `STOCK-TEST-${Date.now()}-${Math.random()}`,
        precioVenta: new Prisma.Decimal('99.00'),
        costoActual: new Prisma.Decimal(costoActualInicial),
        stockActual: 0,
      },
    });
    createdVariantIds.push(variant.id);
    return variant.id;
  }

  async function entrada(
    variantId: number,
    cantidad: number,
    costoUnitario: string,
  ): Promise<void> {
    await prisma.$transaction((tx) =>
      service.registrarEntrada(tx, {
        variantId,
        cantidad,
        costoUnitario: new Prisma.Decimal(costoUnitario),
        userId,
      }),
    );
  }

  async function ajuste(
    variantId: number,
    delta: number,
    motivo: string,
  ): Promise<void> {
    await prisma.$transaction((tx) =>
      service.registrarAjuste(tx, { variantId, delta, motivo, userId }),
    );
  }

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `stock-test-owner-${Date.now()}@manitas.local`,
        passwordHash: 'no-se-usa-en-este-archivo',
        nombre: 'Owner de prueba (stock)',
        rol: 'OWNER',
        activo: true,
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (createdVariantIds.length > 0) {
      await prisma.stockMovement.deleteMany({
        where: { variantId: { in: createdVariantIds } },
      });
      await prisma.priceHistory.deleteMany({
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
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  describe('registrarEntrada (RN-4, AD-6, invariante 1)', () => {
    it('crea un movimiento ENTRADA, suma la cantidad a stock_actual, actualiza costo_actual, y el invariante 1 se cumple', async () => {
      const variantId = await createTestVariant('5.00');

      await entrada(variantId, 8, '11.50');

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(8);
      expect(variant.costoActual.toString()).toBe('11.5');

      const movements = await prisma.stockMovement.findMany({
        where: { variantId },
      });
      expect(movements).toHaveLength(1);
      expect(movements[0]).toMatchObject({
        tipo: StockMovementTipo.ENTRADA,
        delta: 8,
        userId,
      });
      expect(movements[0].costoUnitario?.toString()).toBe('11.5');

      // Invariante 1 (AD-4): stock_actual == SUM(stock_movements.delta).
      expect(await sumMovementDeltas(variantId)).toBe(variant.stockActual);
    });

    it('dos entradas sucesivas sobre la misma variante suman el stock correctamente y el invariante 1 se sigue cumpliendo', async () => {
      const variantId = await createTestVariant('3.00');

      await entrada(variantId, 3, '10.00');
      await entrada(variantId, 4, '10.00');

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(7);
      expect(await sumMovementDeltas(variantId)).toBe(7);

      const movements = await prisma.stockMovement.findMany({
        where: { variantId },
      });
      expect(movements).toHaveLength(2);
    });

    // Agregado en la Fase 04 (implementación) — RN-10/AD-16, ver el mismo
    // agregado en stock.service.spec.ts para el porqué.
    it('RN-10/AD-16: deja un registro en price_history con origen INGRESO_MERCADERIA', async () => {
      const variantId = await createTestVariant('5.00');

      await entrada(variantId, 8, '11.50');

      const history = await prisma.priceHistory.findFirst({
        where: { variantId, origen: 'INGRESO_MERCADERIA' },
      });
      expect(history).toMatchObject({
        campo: 'COSTO',
        valorNuevo: expect.anything() as unknown,
      });
      expect(history?.valorAnterior?.toString()).toBe('5');
      expect(history?.valorNuevo.toString()).toBe('11.5');
    });
  });

  describe('registrarAjuste — delta positivo (RN-5, invariante 1)', () => {
    it('con motivo, suma al stock, deja el movimiento AJUSTE sin costo_unitario, y el invariante 1 se cumple', async () => {
      const variantId = await createTestVariant();
      await entrada(variantId, 5, '10.00');

      await ajuste(variantId, 2, 'Aparecieron unidades en el conteo físico');

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(7);
      expect(await sumMovementDeltas(variantId)).toBe(7);

      const ajusteMovement = await prisma.stockMovement.findFirst({
        where: { variantId, tipo: StockMovementTipo.AJUSTE },
      });
      expect(ajusteMovement).toMatchObject({
        delta: 2,
        motivo: 'Aparecieron unidades en el conteo físico',
      });
      expect(ajusteMovement?.costoUnitario).toBeNull();
    });
  });

  describe('registrarAjuste — delta negativo dentro del stock disponible (RN-5, invariante 1)', () => {
    it('descuenta del stock, y el invariante 1 se cumple', async () => {
      const variantId = await createTestVariant();
      await entrada(variantId, 6, '10.00');

      await ajuste(variantId, -4, 'Rotura de mercadería');

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(2);
      expect(await sumMovementDeltas(variantId)).toBe(2);
    });

    it('caso límite: un ajuste que deja stock_actual exactamente en 0 se acepta (invariante 5 exige >= 0, no > 0)', async () => {
      const variantId = await createTestVariant();
      await entrada(variantId, 3, '10.00');

      await ajuste(variantId, -3, 'Ajuste a cero por fin de temporada');

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(0);
      expect(await sumMovementDeltas(variantId)).toBe(0);
    });
  });

  describe('registrarAjuste — rechazo (RN-5, invariante 5, invariante 6)', () => {
    it('un ajuste que dejaría stock_actual negativo se rechaza con el mensaje de negocio (§7), no crea ningún movimiento AJUSTE y no toca stock_actual', async () => {
      const variantId = await createTestVariant();
      await entrada(variantId, 3, '10.00');

      await expect(ajuste(variantId, -10, 'Intento inválido')).rejects.toThrow(
        /quedan 3 unidad/i,
      );

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(3);

      const ajusteMovements = await prisma.stockMovement.count({
        where: { variantId, tipo: StockMovementTipo.AJUSTE },
      });
      expect(ajusteMovements).toBe(0);
      expect(await sumMovementDeltas(variantId)).toBe(variant.stockActual);
    });

    it('un ajuste sin motivo se rechaza aunque el delta sea válido, y no crea ningún movimiento (invariante 6: AJUSTE siempre con motivo)', async () => {
      const variantId = await createTestVariant();
      await entrada(variantId, 5, '10.00');

      await expect(ajuste(variantId, 2, '')).rejects.toThrow(/motivo/i);

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(5);
      const ajusteMovements = await prisma.stockMovement.count({
        where: { variantId, tipo: StockMovementTipo.AJUSTE },
      });
      expect(ajusteMovements).toBe(0);
    });
  });

  describe('invariante 1 tras una secuencia mixta de operaciones', () => {
    it('entrada + ajuste positivo + ajuste negativo dejan stock_actual exactamente igual a la suma de los deltas', async () => {
      const variantId = await createTestVariant();

      await entrada(variantId, 10, '10.00');
      await ajuste(variantId, 3, 'Conteo físico');
      await ajuste(variantId, -5, 'Rotura');

      const variant = await prisma.variant.findUniqueOrThrow({
        where: { id: variantId },
      });
      expect(variant.stockActual).toBe(8); // 10 + 3 - 5
      expect(await sumMovementDeltas(variantId)).toBe(variant.stockActual);
    });
  });

  describe('concurrencia (§7, invariante 5) — dos ajustes negativos simultáneos que individualmente son válidos pero juntos dejarían el stock negativo', () => {
    it('solo uno de los dos se aplica; stock_actual nunca queda negativo; el invariante 1 se cumple al final', async () => {
      // Repetido varias veces con datos frescos cada vez: a nivel de
      // llamada directa a Prisma (sin el overhead HTTP de
      // users.integration.spec.ts) la ventana de la carrera es más
      // angosta — una sola vuelta podría no alcanzar a exponer el bug si
      // no hay lock. Mismo patrón de prueba que la fase 08 de `auth`
      // (última baja de OWNER), adaptado a stock.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const variantId = await createTestVariant();
        await entrada(variantId, 5, '10.00');

        const results = await Promise.allSettled([
          ajuste(variantId, -3, `Carrera A intento ${attempt}`),
          ajuste(variantId, -3, `Carrera B intento ${attempt}`),
        ]);

        const fulfilled = results.filter((r) => r.status === 'fulfilled');
        const rejected = results.filter((r) => r.status === 'rejected');

        // 5 - 3 = 2 es válido una vez; 5 - 3 - 3 = -1 nunca debe pasar.
        // Sin el bloqueo de fila (BLUEPRINT §7/§9.4), las dos lecturas
        // concurrentes de stock_actual pueden ver "5" a la vez y las dos
        // pasar la validación, dejando el contador en -1.
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        const variant = await prisma.variant.findUniqueOrThrow({
          where: { id: variantId },
        });
        expect(variant.stockActual).toBeGreaterThanOrEqual(0);
        expect(variant.stockActual).toBe(2);
        expect(await sumMovementDeltas(variantId)).toBe(variant.stockActual);

        const ajusteCount = await prisma.stockMovement.count({
          where: { variantId, tipo: StockMovementTipo.AJUSTE },
        });
        expect(ajusteCount).toBe(1);
      }
    });
  });
});
