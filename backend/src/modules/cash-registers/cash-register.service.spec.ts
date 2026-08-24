import { Prisma, CashMovementTipo, CashRegisterSessionEstado } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import { CashRegisterService } from './cash-register.service';

// Fase 04a (T3.1 + T3.2) — tests escritos ANTES de la implementación, contra
// Prisma completamente mockeado (BLUEPRINT §9.8, excepción "plata y stock":
// los tests se escriben primero, derivados de la especificación, y se
// verifica que fallen antes de implementar).
//
// Fuente única: `docs/build-protocol/state/ROADMAP.md` (T3.1, T3.2),
// `BLUEPRINT.md` (§3.6, §5.1, §5.5, invariantes 2/7/9/10, §7, §9.3, §9.4,
// §9.7) y `docs/build-protocol/state/reports/modulo-cash-registers-spec.md`
// (RN-1 a RN-12, secciones 4.2, 5, 6, 7, 9). No se miró ninguna
// implementación de otro módulo (`stock.service.ts` ni ningún
// `*.controller.ts` salvo los de este módulo, que todavía no existen) — solo
// la ESTRUCTURA de `stock.service.spec.ts` (patrón MockTx/asTx) como
// convención mecánica del repo.
//
// Diseño del mock de `tx`: igual que en `stock.service.spec.ts`, `MockTx` es
// un tipo propio sin intersecar `Prisma.TransactionClient` (evita falsos
// positivos de lint `unbound-method`/`no-unsafe-assignment`). La spec
// (sección 4.2) no fija qué método de Prisma usa la implementación real para
// leer la fila de sesión antes de insertar un movimiento (podría ser
// `findUnique`, `findUniqueOrThrow`, `findFirst`, o resolver del mismo
// `$queryRaw` del lock de la sección 5) — el mock resuelve el mismo valor
// sea cual sea el método que termine usando la implementación, para no
// adivinar ese detalle.

interface SessionRow {
  id: number;
  fechaApertura: Date;
  userIdApertura: number;
  montoInicial: Prisma.Decimal;
  fechaCierre: Date | null;
  userIdCierre: number | null;
  montoDeclarado: Prisma.Decimal | null;
  montoSistema: Prisma.Decimal | null;
  diferencia: Prisma.Decimal | null;
  notaCierre: string | null;
  estado: CashRegisterSessionEstado;
}

function buildSessionRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 1,
    fechaApertura: new Date('2026-08-24T10:00:00-03:00'),
    userIdApertura: 7,
    montoInicial: new Prisma.Decimal('100.00'),
    fechaCierre: null,
    userIdCierre: null,
    montoDeclarado: null,
    montoSistema: null,
    diferencia: null,
    notaCierre: null,
    estado: CashRegisterSessionEstado.ABIERTA,
    ...overrides,
  };
}

interface MockTx {
  cashRegisterSession: {
    create: jest.Mock;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  cashMovement: {
    create: jest.Mock;
  };
  $queryRaw: jest.Mock;
}

// `sessionOrNull`: fila que debe "ver" el servicio al buscar la sesión
// (referenciada por id o la sesión ABIERTA actual, según el método). `null`
// simula que no existe/no hay ninguna.
function buildMockTx(sessionOrNull: SessionRow | null): MockTx {
  return {
    cashRegisterSession: {
      create: jest.fn().mockResolvedValue(sessionOrNull ?? buildSessionRow()),
      findUnique: jest.fn().mockResolvedValue(sessionOrNull),
      findUniqueOrThrow: jest
        .fn()
        .mockImplementation(() =>
          sessionOrNull
            ? Promise.resolve(sessionOrNull)
            : Promise.reject(new Error('No record found')),
        ),
      findFirst: jest.fn().mockResolvedValue(sessionOrNull),
      update: jest.fn().mockResolvedValue(sessionOrNull ?? buildSessionRow()),
    },
    cashMovement: {
      create: jest.fn().mockResolvedValue({ id: 999 }),
    },
    $queryRaw: jest
      .fn()
      .mockResolvedValue(sessionOrNull ? [{ id: sessionOrNull.id }] : []),
  };
}

function asTx(tx: MockTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

describe('CashRegisterService', () => {
  let service: CashRegisterService;

  beforeEach(() => {
    // El constructor recibe PrismaService (contrato del repo, mismo patrón
    // que `new StockService(prisma)`), pero los tres métodos bajo test
    // reciben siempre el `tx` de una transacción ya abierta (sección 4.2:
    // "no abren la suya propia") — el prisma inyectado no se usa acá.
    service = new CashRegisterService({} as PrismaService);
  });

  describe('abrirSesion (RN-1, invariante 9)', () => {
    it('camino feliz: crea la sesión con montoInicial y userId, en estado ABIERTA', async () => {
      const tx = buildMockTx(null);

      const result = await service.abrirSesion(asTx(tx), {
        montoInicial: new Prisma.Decimal('500.00'),
        userId: 7,
      });

      expect(result.estado).toBe(CashRegisterSessionEstado.ABIERTA);
      expect(tx.cashRegisterSession.create).toHaveBeenCalledTimes(1);
      const call = tx.cashRegisterSession.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.userIdApertura).toBe(7);
      expect((call.data.montoInicial as Prisma.Decimal).toString()).toBe(
        '500',
      );
      expect(call.data.estado ?? CashRegisterSessionEstado.ABIERTA).toBe(
        CashRegisterSessionEstado.ABIERTA,
      );
    });

    it('caso borde: montoInicial = 0 es válido (sección 6 de la spec)', async () => {
      const tx = buildMockTx(null);

      await expect(
        service.abrirSesion(asTx(tx), {
          montoInicial: new Prisma.Decimal('0.00'),
          userId: 7,
        }),
      ).resolves.toBeDefined();

      expect(tx.cashRegisterSession.create).toHaveBeenCalledTimes(1);
    });

    it('rechaza montoInicial negativo sin llegar a insertar (sección 6, §7 "El monto inicial no puede ser negativo")', async () => {
      const tx = buildMockTx(null);

      await expect(
        service.abrirSesion(asTx(tx), {
          montoInicial: new Prisma.Decimal('-1.00'),
          userId: 7,
        }),
      ).rejects.toThrow(/negativo/i);

      expect(tx.cashRegisterSession.create).not.toHaveBeenCalled();
    });
  });

  describe('registrarMovimiento — convención de signo (RN-3, obligatoria)', () => {
    const positiveTypes: CashMovementTipo[] = [
      CashMovementTipo.VENTA,
      CashMovementTipo.INGRESO_MANUAL,
    ];
    const negativeTypes: CashMovementTipo[] = [
      CashMovementTipo.DEVOLUCION,
      CashMovementTipo.ANULACION,
      CashMovementTipo.GASTO,
      CashMovementTipo.RETIRO,
    ];

    it.each(positiveTypes)(
      'tipo %s: recibe monto positivo y lo inserta positivo',
      async (tipo) => {
        const tx = buildMockTx(buildSessionRow());

        await service.registrarMovimiento(asTx(tx), {
          sessionId: 1,
          tipo,
          monto: new Prisma.Decimal('250.00'),
          descripcion: 'Movimiento de prueba',
          userId: 7,
        });

        expect(tx.cashMovement.create).toHaveBeenCalledTimes(1);
        const call = tx.cashMovement.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect((call.data.monto as Prisma.Decimal).toString()).toBe('250');
        expect(call.data.tipo).toBe(tipo);
      },
    );

    it.each(negativeTypes)(
      'tipo %s: recibe monto positivo pero lo inserta negativo',
      async (tipo) => {
        const tx = buildMockTx(buildSessionRow());

        await service.registrarMovimiento(asTx(tx), {
          sessionId: 1,
          tipo,
          monto: new Prisma.Decimal('250.00'),
          descripcion: 'Movimiento de prueba',
          userId: 7,
        });

        expect(tx.cashMovement.create).toHaveBeenCalledTimes(1);
        const call = tx.cashMovement.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect((call.data.monto as Prisma.Decimal).toString()).toBe('-250');
        expect(call.data.tipo).toBe(tipo);
      },
    );
  });

  describe('registrarMovimiento — validaciones (RN-3, RN-8, §7)', () => {
    it('rechaza monto <= 0 (probando 0 y negativo) sin insertar nada', async () => {
      const tx = buildMockTx(buildSessionRow());

      await expect(
        service.registrarMovimiento(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.INGRESO_MANUAL,
          monto: new Prisma.Decimal('0.00'),
          descripcion: 'Monto inválido',
          userId: 7,
        }),
      ).rejects.toThrow(/mayor a 0/i);

      await expect(
        service.registrarMovimiento(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.INGRESO_MANUAL,
          monto: new Prisma.Decimal('-10.00'),
          descripcion: 'Monto inválido',
          userId: 7,
        }),
      ).rejects.toThrow(/mayor a 0/i);

      expect(tx.cashMovement.create).not.toHaveBeenCalled();
    });

    it('rechaza descripcion vacía sin insertar nada', async () => {
      const tx = buildMockTx(buildSessionRow());

      await expect(
        service.registrarMovimiento(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.INGRESO_MANUAL,
          monto: new Prisma.Decimal('100.00'),
          descripcion: '',
          userId: 7,
        }),
      ).rejects.toThrow(/descripci[oó]n/i);

      expect(tx.cashMovement.create).not.toHaveBeenCalled();
    });

    it('rechaza registrar un movimiento contra una sesión CERRADA sin insertar nada (RN-8, inmutabilidad tras el cierre)', async () => {
      const tx = buildMockTx(
        buildSessionRow({ estado: CashRegisterSessionEstado.CERRADA }),
      );

      await expect(
        service.registrarMovimiento(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.VENTA,
          monto: new Prisma.Decimal('100.00'),
          descripcion: 'Venta contra sesión cerrada',
          userId: 7,
        }),
      ).rejects.toThrow(/cerrada/i);

      expect(tx.cashMovement.create).not.toHaveBeenCalled();
    });
  });

  describe('getSesionAbiertaOrThrow (RN-10, invariante 9)', () => {
    it('devuelve la sesión si hay una ABIERTA', async () => {
      const abierta = buildSessionRow({ id: 42 });
      const tx = buildMockTx(abierta);

      const result = await service.getSesionAbiertaOrThrow(asTx(tx));

      expect(result.id).toBe(42);
      expect(result.estado).toBe(CashRegisterSessionEstado.ABIERTA);
    });

    it('lanza si no hay ninguna sesión ABIERTA', async () => {
      const tx = buildMockTx(null);

      await expect(service.getSesionAbiertaOrThrow(asTx(tx))).rejects.toThrow(
        /sesi[oó]n.*abiert/i,
      );
    });
  });
});
