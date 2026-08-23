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

function createMockTx(stockActual?: number) {
  const variantRow = { id: 1, stockActual: stockActual ?? 0 };

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
    $queryRaw: jest.fn().mockResolvedValue([{ id: 1 }]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: 1 }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
  } as unknown as Prisma.TransactionClient & {
    stockMovement: { create: jest.Mock };
    variant: {
      update: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findFirst: jest.Mock;
    };
  };
}

describe('StockService', () => {
  let service: StockService;
  let prismaMock: { $transaction: jest.Mock };

  beforeEach(() => {
    prismaMock = { $transaction: jest.fn() };
    service = new StockService(prismaMock as unknown as PrismaService);
  });

  describe('registrarEntrada (RN-4, invariante 1, AD-4)', () => {
    it('camino feliz: resuelve, escribe un movimiento ENTRADA con el costo unitario recibido y aumenta stock_actual exactamente en la cantidad ingresada', async () => {
      const tx = createMockTx();

      await expect(
        service.registrarEntrada(tx, {
          variantId: 1,
          cantidad: 10,
          costoUnitario: new Prisma.Decimal('25.50'),
          userId: 7,
        }),
      ).resolves.toBeUndefined();

      expect(tx.stockMovement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            variantId: 1,
            delta: 10,
            tipo: 'ENTRADA',
            userId: 7,
          }),
        }),
      );
      expect(tx.variant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 1 },
          data: expect.objectContaining({
            stockActual: { increment: 10 },
          }),
        }),
      );

      // Contrato sección 4.2: recibe el `tx` ya abierto por quien llama y
      // nunca abre su propia transacción.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('RN-4 / AD-6: actualiza costo_actual de la variante al costo unitario de esta entrada (costeo por último costo)', async () => {
      const tx = createMockTx();

      await service
        .registrarEntrada(tx, {
          variantId: 3,
          cantidad: 5,
          costoUnitario: new Prisma.Decimal('12.00'),
          userId: 2,
        })
        .catch(() => undefined);

      expect(tx.variant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 3 },
          data: expect.objectContaining({
            costoActual: expect.anything(),
          }),
        }),
      );
    });

    it('el movimiento ENTRADA registra el costo_unitario recibido (obligatorio para este tipo, §3.3)', async () => {
      const tx = createMockTx();

      await service
        .registrarEntrada(tx, {
          variantId: 4,
          cantidad: 2,
          costoUnitario: new Prisma.Decimal('8.75'),
          userId: 1,
        })
        .catch(() => undefined);

      expect(tx.stockMovement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            costoUnitario: expect.anything(),
          }),
        }),
      );
    });

  });

  describe('registrarAjuste — delta positivo (RN-5)', () => {
    it('camino feliz: con motivo, resuelve, escribe un movimiento AJUSTE con el delta y el motivo recibidos, y aumenta stock_actual', async () => {
      const tx = createMockTx(5);

      await expect(
        service.registrarAjuste(tx, {
          variantId: 1,
          delta: 4,
          motivo: 'Conteo físico: sobraban 4 unidades',
          userId: 9,
        }),
      ).resolves.toBeUndefined();

      expect(tx.stockMovement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            variantId: 1,
            delta: 4,
            tipo: 'AJUSTE',
            motivo: 'Conteo físico: sobraban 4 unidades',
            userId: 9,
          }),
        }),
      );

      // Contrato sección 4.2: recibe el `tx` ya abierto por quien llama y
      // nunca abre su propia transacción.
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('registrarAjuste — delta negativo (RN-5, invariante 5, §7 concurrencia)', () => {
    it('camino feliz: delta negativo que deja stock_actual en un valor positivo se acepta y descuenta esa cantidad', async () => {
      const tx = createMockTx(10);

      await expect(
        service.registrarAjuste(tx, {
          variantId: 1,
          delta: -3,
          motivo: 'Rotura',
          userId: 9,
        }),
      ).resolves.toBeUndefined();

      expect(tx.stockMovement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ delta: -3, tipo: 'AJUSTE' }),
        }),
      );
    });

    it('caso límite: un ajuste que deja stock_actual exactamente en 0 se acepta (invariante 5 exige >= 0, no > 0)', async () => {
      const tx = createMockTx(3);

      await expect(
        service.registrarAjuste(tx, {
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
        service.registrarAjuste(tx, {
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
        service.registrarAjuste(tx, {
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
        service.registrarAjuste(tx, {
          variantId: 1,
          delta: -2,
          motivo: '   ',
          userId: 9,
        }),
      ).rejects.toThrow(/motivo/i);

      expect(tx.stockMovement.create).not.toHaveBeenCalled();
    });
  });
});
