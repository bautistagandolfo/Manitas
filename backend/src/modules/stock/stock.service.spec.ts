import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from './stock.service';

// Fase 04a (T2.4) — tests escritos ANTES de la implementación, contra el
// stub que solo lanza 'T2.4 todavía no implementado'. Fuente única: el
// ticket T2.4 en `state/ROADMAP.md`, BLUEPRINT.md (AD-4, §3.3, §5.2, §6
// invariantes 1/5/6, §7, §9.3, §9.4) y
// `state/reports/modulo-products-variants-spec.md` (RN-4, RN-5, RN-8,
// RN-10, secciones 3, 4.2, 5, 6, 7, 9). No se miró ninguna implementación.
//
// Diseño del mock de `tx`: como los dos métodos reciben la transacción ya
// abierta por quien llama (contrato de la sección 4.2 — "no abren la suya
// propia"), acá se simula ese `tx` con Prisma completamente mockeado. Para
// la lectura de `stock_actual` previa a un ajuste con delta negativo, la
// sección 5 de la spec no fija un único método de Prisma (podría ser
// `findUnique`, `findUniqueOrThrow` o resolver del mismo `SELECT ... FOR
// UPDATE`) — el mock resuelve el mismo valor sea cual sea el método que
// termine usando la implementación real, para no adivinar ese detalle.

// Nota de la Fase 04 (implementación, no tests-first): el mock original de
// esta función no incluía `priceHistory` ni `costoActual` en la fila de
// variante — RN-10 (AD-16) exige que `registrarEntrada` deje un rastro en
// `price_history` cada vez que cambia `costo_actual`, y la fase 04a no
// había anticipado esa escritura. Es un agregado a la infraestructura del
// mock, no un debilitamiento de ninguna aserción existente — se puede
// confirmar en el diff de este commit que ninguna expectativa previa
// cambió.
//
// MockTx es un tipo propio, sin intersección con Prisma.TransactionClient:
// intersecarlo (como en la versión original de esta fase) hace que TS
// resuelva `tx.stockMovement.create` como una mezcla del método real de
// Prisma y el jest.Mock, y el linter marca falsos positivos de
// `unbound-method` y `no-unsafe-assignment` sobre algo que nunca se
// invoca fuera de una aserción. `tx` se castea a `Prisma.TransactionClient`
// solo en el borde, al llamar al servicio real.
interface MockTx {
  stockMovement: { create: jest.Mock };
  variant: {
    update: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
  };
  priceHistory: { create: jest.Mock };
  $queryRaw: jest.Mock;
}

function createMockTx(stockActual?: number): MockTx {
  const variantRow = {
    id: 1,
    stockActual: stockActual ?? 0,
    costoActual: new Prisma.Decimal('1.00'),
  };

  return {
    stockMovement: {
      create: jest.fn().mockResolvedValue({ id: 999 }),
    },
    variant: {
      update: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(variantRow),
      findUniqueOrThrow: jest.fn().mockResolvedValue(variantRow),
      findFirst: jest.fn().mockResolvedValue(variantRow),
    },
    priceHistory: {
      create: jest.fn().mockResolvedValue({ id: 888 }),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
  };
}

function asTx(tx: MockTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

interface PrismaMock {
  $transaction: jest.Mock;
  variant: { findMany: jest.Mock };
  stockMovement: { groupBy: jest.Mock };
}

// reconciliar() abre su propia transacción (a diferencia de
// registrarEntrada/registrarAjuste, que reciben la de quien llama) —
// $transaction acá simula ese comportamiento invocando el callback con el
// mismo mock como si fuera el `tx`, ya que a jest.fn() no le importa la
// diferencia entre PrismaService y TransactionClient.
function createPrismaMock(): PrismaMock {
  const mock: PrismaMock = {
    $transaction: jest.fn(),
    variant: { findMany: jest.fn() },
    stockMovement: { groupBy: jest.fn() },
  };
  mock.$transaction.mockImplementation((cb: (tx: PrismaMock) => unknown) =>
    cb(mock),
  );
  return mock;
}

describe('StockService', () => {
  let service: StockService;
  let prismaMock: PrismaMock;

  beforeEach(() => {
    prismaMock = createPrismaMock();
    service = new StockService(prismaMock as unknown as PrismaService);
  });

  describe('registrarEntrada (RN-4, invariante 1, AD-4)', () => {
    it('camino feliz: resuelve, escribe un movimiento ENTRADA con el costo unitario recibido y aumenta stock_actual exactamente en la cantidad ingresada', async () => {
      const tx = createMockTx();

      await expect(
        service.registrarEntrada(asTx(tx), {
          variantId: 1,
          cantidad: 10,
          costoUnitario: new Prisma.Decimal('25.50'),
          userId: 7,
        }),
      ).resolves.toBeUndefined();

      expect(tx.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          variantId: 1,
          delta: 10,
          tipo: 'ENTRADA',
          userId: 7,
        }) as unknown,
      });
      expect(tx.variant.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: expect.objectContaining({
          stockActual: { increment: 10 },
        }) as unknown,
      });
      // Fase 08 (QA adversarial, Stryker): sin esta aserción, un mutante
      // que reemplaza el `where` de esta lectura por `{}` sobrevive.
      expect(tx.variant.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 1 },
      });

      // Contrato sección 4.2: recibe el `tx` ya abierto por quien llama y
      // nunca abre su propia transacción.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('RN-4 / AD-6: actualiza costo_actual de la variante al costo unitario de esta entrada (costeo por último costo)', async () => {
      const tx = createMockTx();

      await service
        .registrarEntrada(asTx(tx), {
          variantId: 3,
          cantidad: 5,
          costoUnitario: new Prisma.Decimal('12.00'),
          userId: 2,
        })
        .catch(() => undefined);

      expect(tx.variant.update).toHaveBeenCalledWith({
        where: { id: 3 },
        data: expect.objectContaining({
          costoActual: expect.anything() as unknown,
        }) as unknown,
      });
    });

    it('el movimiento ENTRADA registra el costo_unitario recibido (obligatorio para este tipo, §3.3)', async () => {
      const tx = createMockTx();

      await service
        .registrarEntrada(asTx(tx), {
          variantId: 4,
          cantidad: 2,
          costoUnitario: new Prisma.Decimal('8.75'),
          userId: 1,
        })
        .catch(() => undefined);

      expect(tx.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          costoUnitario: expect.anything() as unknown,
        }) as unknown,
      });
    });

    // Agregado en la Fase 04 (implementación): la Fase 04a no había
    // escrito ningún test para esto — RN-10/AD-16 exige que todo cambio
    // de costo_actual, incluido por ingreso de mercadería, quede
    // registrado en price_history. No es un test que ablande una
    // aserción existente, es cobertura nueva de una regla de negocio que
    // la fase de tests-first pasó por alto.
    it('RN-10/AD-16: deja un registro en price_history con origen INGRESO_MERCADERIA, valor anterior y nuevo', async () => {
      const tx = createMockTx();

      await service.registrarEntrada(asTx(tx), {
        variantId: 1,
        cantidad: 10,
        costoUnitario: new Prisma.Decimal('25.50'),
        userId: 7,
      });

      expect(tx.priceHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          variantId: 1,
          campo: 'COSTO',
          origen: 'INGRESO_MERCADERIA',
          userId: 7,
          valorNuevo: expect.anything() as unknown,
        }) as unknown,
      });
    });
  });

  describe('registrarAjuste — delta positivo (RN-5)', () => {
    it('camino feliz: con motivo, resuelve, escribe un movimiento AJUSTE con el delta y el motivo recibidos, y aumenta stock_actual', async () => {
      const tx = createMockTx(5);

      await expect(
        service.registrarAjuste(asTx(tx), {
          variantId: 1,
          delta: 4,
          motivo: 'Conteo físico: sobraban 4 unidades',
          userId: 9,
        }),
      ).resolves.toBeUndefined();

      expect(tx.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          variantId: 1,
          delta: 4,
          tipo: 'AJUSTE',
          motivo: 'Conteo físico: sobraban 4 unidades',
          userId: 9,
        }) as unknown,
      });
      // Fase 08 (QA adversarial, Stryker): match exacto (no
      // objectContaining) para matar mutantes que vacían este objeto.
      expect(tx.variant.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { stockActual: { increment: 4 } },
      });
      // Delta positivo no necesita el lock de §7/§9.4 (ese es solo para
      // delta negativo) — si esta rama se saltea o el `if` se evalúa mal,
      // el flujo cae en la rama de abajo y termina llamando $queryRaw.
      expect(tx.$queryRaw).not.toHaveBeenCalled();

      // Contrato sección 4.2: recibe el `tx` ya abierto por quien llama y
      // nunca abre su propia transacción.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('caso límite delta = 0: toma la rama positiva (>= 0, no > 0) y no pide el lock de la rama negativa', async () => {
      const tx = createMockTx(5);

      await expect(
        service.registrarAjuste(asTx(tx), {
          variantId: 1,
          delta: 0,
          motivo: 'Conteo físico: sin diferencias',
          userId: 9,
        }),
      ).resolves.toBeUndefined();

      expect(tx.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ delta: 0, tipo: 'AJUSTE' }) as unknown,
      });
      expect(tx.variant.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { stockActual: { increment: 0 } },
      });
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('registrarAjuste — delta negativo (RN-5, invariante 5, §7 concurrencia)', () => {
    it('camino feliz: delta negativo que deja stock_actual en un valor positivo se acepta y descuenta esa cantidad', async () => {
      const tx = createMockTx(10);

      await expect(
        service.registrarAjuste(asTx(tx), {
          variantId: 1,
          delta: -3,
          motivo: 'Rotura',
          userId: 9,
        }),
      ).resolves.toBeUndefined();

      expect(tx.stockMovement.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          delta: -3,
          tipo: 'AJUSTE',
        }) as unknown,
      });
      // Fase 08 (QA adversarial, Stryker): match exacto para matar
      // mutantes que vacían el `data`/`where` de este update final.
      expect(tx.variant.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { stockActual: { increment: -3 } },
      });
      // §7/§9.4: bloquea la fila antes de leer stock_actual — verifica
      // que el lock se pida por el id correcto (no un query vacío).
      expect(tx.$queryRaw).toHaveBeenCalled();
      const rawCall = tx.$queryRaw.mock.calls[0] as unknown[];
      expect(rawCall).toContain(1);
      expect(tx.variant.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 1 },
      });
    });

    it('caso límite: un ajuste que deja stock_actual exactamente en 0 se acepta (invariante 5 exige >= 0, no > 0)', async () => {
      const tx = createMockTx(3);

      await expect(
        service.registrarAjuste(asTx(tx), {
          variantId: 1,
          delta: -3,
          motivo: 'Ajuste a cero por cierre de temporada',
          userId: 9,
        }),
      ).resolves.toBeUndefined();
    });

    it('RN-5 / invariante 5: un ajuste que dejaría stock_actual negativo se rechaza con el mensaje de negocio (§7) y no queda ningún movimiento registrado', async () => {
      const tx = createMockTx(3);

      // Con stock_actual = 3, un delta de -10 dejaría -7: debe rechazarse
      // siempre (RN-5: "sin excepción de permitir_venta_sin_stock" — esa
      // bandera no aplica acá, es de `sales`, no de un ajuste manual).
      await expect(
        service.registrarAjuste(asTx(tx), {
          variantId: 1,
          delta: -10,
          motivo: 'Intento inválido',
          userId: 9,
        }),
        // Mensaje de la tabla de errores de la spec (sección 7): "No podés
        // ajustar a −N: quedan M unidades". Se compara de forma laxa
        // (número de unidades restantes + la palabra "unidad") para no
        // depender de la puntuación exacta, pero sí de que el rechazo sea
        // el de negocio y no el placeholder del stub.
      ).rejects.toThrow(/quedan 3 unidad/i);

      expect(tx.stockMovement.create).not.toHaveBeenCalled();
      expect(tx.variant.update).not.toHaveBeenCalled();
    });
  });

  describe('registrarAjuste — motivo obligatorio (RN-5, invariante 6)', () => {
    it('rechaza un ajuste con delta positivo sin motivo, con el mensaje de negocio (§7), y no escribe ningún movimiento', async () => {
      const tx = createMockTx(5);

      await expect(
        service.registrarAjuste(asTx(tx), {
          variantId: 1,
          delta: 2,
          motivo: '',
          userId: 9,
        }),
      ).rejects.toThrow(/motivo/i);

      expect(tx.stockMovement.create).not.toHaveBeenCalled();
    });

    it('rechaza un ajuste con delta negativo sin motivo, con el mensaje de negocio (§7), y no escribe ningún movimiento', async () => {
      const tx = createMockTx(5);

      await expect(
        service.registrarAjuste(asTx(tx), {
          variantId: 1,
          delta: -2,
          motivo: '   ',
          userId: 9,
        }),
      ).rejects.toThrow(/motivo/i);

      expect(tx.stockMovement.create).not.toHaveBeenCalled();
    });
  });

  describe('reconciliar (T2.8, invariante 1)', () => {
    it('sin variantes, no hay nada que reconciliar: devuelve la lista vacía', async () => {
      prismaMock.variant.findMany.mockResolvedValue([]);
      prismaMock.stockMovement.groupBy.mockResolvedValue([]);

      await expect(service.reconciliar()).resolves.toEqual([]);
    });

    it('cuando stock_actual coincide con SUM(delta), no reporta esa variante', async () => {
      prismaMock.variant.findMany.mockResolvedValue([
        { id: 1, stockActual: 7 },
      ]);
      prismaMock.stockMovement.groupBy.mockResolvedValue([
        { variantId: 1, _sum: { delta: 7 } },
      ]);

      await expect(service.reconciliar()).resolves.toEqual([]);
    });

    it('una variante sin ningún movimiento reconcilia contra 0, no contra null/undefined', async () => {
      prismaMock.variant.findMany.mockResolvedValue([
        { id: 2, stockActual: 0 },
      ]);
      prismaMock.stockMovement.groupBy.mockResolvedValue([]);

      await expect(service.reconciliar()).resolves.toEqual([]);
    });

    it('cuando stock_actual no coincide con SUM(delta), reporta el desajuste con ambos valores', async () => {
      prismaMock.variant.findMany.mockResolvedValue([
        { id: 3, stockActual: 10 },
      ]);
      prismaMock.stockMovement.groupBy.mockResolvedValue([
        { variantId: 3, _sum: { delta: 6 } },
      ]);

      await expect(service.reconciliar()).resolves.toEqual([
        { variantId: 3, stockActual: 10, sumaMovimientos: 6 },
      ]);
    });

    it('reporta solo las variantes desajustadas, no todo el universo de variantes', async () => {
      prismaMock.variant.findMany.mockResolvedValue([
        { id: 1, stockActual: 5 },
        { id: 2, stockActual: 99 },
      ]);
      prismaMock.stockMovement.groupBy.mockResolvedValue([
        { variantId: 1, _sum: { delta: 5 } },
        { variantId: 2, _sum: { delta: 3 } },
      ]);

      await expect(service.reconciliar()).resolves.toEqual([
        { variantId: 2, stockActual: 99, sumaMovimientos: 3 },
      ]);
    });

    // Fase 08 (QA adversarial, Stryker): ninguno de los tests anteriores
    // verifica la FORMA de las consultas en sí (solo lo que devuelven vía
    // el mock) — sin esto, mutantes que vacían el `select`/`by`/`_sum` o
    // sacan el isolationLevel sobreviven porque el mock ignora sus
    // argumentos y devuelve igual el valor seteado a mano.
    it('consulta variant.findMany y stockMovement.groupBy con la forma exacta esperada, en REPEATABLE READ (§ concurrencia)', async () => {
      prismaMock.variant.findMany.mockResolvedValue([]);
      prismaMock.stockMovement.groupBy.mockResolvedValue([]);

      await service.reconciliar();

      expect(prismaMock.variant.findMany).toHaveBeenCalledWith({
        select: { id: true, stockActual: true },
      });
      expect(prismaMock.stockMovement.groupBy).toHaveBeenCalledWith({
        by: ['variantId'],
        _sum: { delta: true },
      });
      expect(prismaMock.$transaction).toHaveBeenCalledWith(
        expect.any(Function) as unknown,
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
    });
  });
});
