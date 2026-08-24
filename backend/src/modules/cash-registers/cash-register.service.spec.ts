import {
  Prisma,
  CashMovementTipo,
  CashRegisterSessionEstado,
} from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SettingsService } from '../../common/settings/settings.service';
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

// Fase 04 (implementación) — hallazgo de tooling, no de negocio: los
// `jest.fn()` sin tipar dejaban `.mock.calls[0][0]` como `any` y disparaban
// `no-unsafe-member-access` en cada sitio que lo leía. Se tipan acá con el
// mismo patrón que `prices.service.spec.ts`/`variants.service.spec.ts`
// (`jest.Mock<ReturnType, [ArgsTuple]>`) — no cambia ninguna aserción
// existente, solo el tipo del mock.
interface CashRegisterSessionCreateCall {
  data: {
    fechaApertura: Date;
    userIdApertura: number;
    montoInicial: Prisma.Decimal.Value;
    estado?: CashRegisterSessionEstado;
  };
}

interface CashMovementCreateCall {
  data: {
    sessionId: number;
    fecha: Date;
    tipo: CashMovementTipo;
    monto: Prisma.Decimal;
    referenciaTipo?: string;
    referenciaId?: number;
    descripcion: string;
    userId: number;
  };
}

interface MockTx {
  cashRegisterSession: {
    create: jest.Mock<Promise<SessionRow>, [CashRegisterSessionCreateCall]>;
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock<Promise<SessionRow>, [unknown]>;
  };
  cashMovement: {
    create: jest.Mock<Promise<{ id: number }>, [CashMovementCreateCall]>;
    // Fase 04a (T3.4) — RN-4/invariante 2: `cerrarSesion` necesita sumar los
    // movimientos de la sesión para calcular `montoSistema`. La spec no fija
    // qué método real de Prisma usa la implementación (`aggregate` vs
    // `findMany` sumado a mano) — se eligió `aggregate` acá por ser el más
    // idiomático para un `SUM`, documentado explícitamente en vez de
    // adivinado en silencio.
    aggregate: jest.Mock<
      Promise<{ _sum: { monto: Prisma.Decimal | null } }>,
      [unknown]
    >;
  };
  $queryRaw: jest.Mock;
}

// `sessionOrNull`: fila que debe "ver" el servicio al buscar la sesión
// (referenciada por id o la sesión ABIERTA actual, según el método). `null`
// simula que no existe/no hay ninguna.
function buildMockTx(sessionOrNull: SessionRow | null): MockTx {
  return {
    cashRegisterSession: {
      create: jest
        .fn<Promise<SessionRow>, [CashRegisterSessionCreateCall]>()
        .mockResolvedValue(sessionOrNull ?? buildSessionRow()),
      findUnique: jest.fn().mockResolvedValue(sessionOrNull),
      findUniqueOrThrow: jest
        .fn()
        .mockImplementation(() =>
          sessionOrNull
            ? Promise.resolve(sessionOrNull)
            : Promise.reject(new Error('No record found')),
        ),
      findFirst: jest.fn().mockResolvedValue(sessionOrNull),
      update: jest
        .fn<Promise<SessionRow>, [unknown]>()
        .mockResolvedValue(sessionOrNull ?? buildSessionRow()),
    },
    cashMovement: {
      create: jest
        .fn<Promise<{ id: number }>, [CashMovementCreateCall]>()
        .mockResolvedValue({ id: 999 }),
      aggregate: jest
        .fn<Promise<{ _sum: { monto: Prisma.Decimal | null } }>, [unknown]>()
        .mockResolvedValue({ _sum: { monto: new Prisma.Decimal('0.00') } }),
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
    // El constructor recibe PrismaService y SettingsService (Fase 04, T3.4:
    // cerrarSesion necesita leer `umbral_diferencia_caja`), pero los
    // métodos de este describe reciben siempre el `tx` de una transacción
    // ya abierta (sección 4.2: "no abren la suya propia") y no llaman a
    // `cerrarSesion` — ninguna de las dos dependencias inyectadas se usa
    // acá. `cerrarSesion` tiene su propia instancia con un mock real de
    // `SettingsService` más abajo (`buildServiceConSettings`).
    service = new CashRegisterService(
      {} as PrismaService,
      {} as SettingsService,
    );
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
      const call = tx.cashRegisterSession.create.mock.calls[0][0];
      expect(call.data.userIdApertura).toBe(7);
      expect(new Prisma.Decimal(call.data.montoInicial).toString()).toBe('500');
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
        const call = tx.cashMovement.create.mock.calls[0][0];
        expect(call.data.monto.toString()).toBe('250');
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
        const call = tx.cashMovement.create.mock.calls[0][0];
        expect(call.data.monto.toString()).toBe('-250');
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

  // Fase 04a (T3.3) — `registrarMovimientoManual` TODAVÍA NO EXISTE en
  // `CashRegisterService` (se agrega recién en la Fase 04, otra sesión); la
  // regla explícita de esta fase prohíbe editar `cash-register.service.ts`
  // para agregarle ni siquiera un stub. La firma esperada está fijada por el
  // ticket T3.3 (spec §4.2, sección 4.2 del reporte del módulo): recibe
  // siempre `monto` positivo (RN-3, mismo criterio que `registrarMovimiento`)
  // y un `idempotencyKey` que la Fase 04 va a escribir en la fila (RN-12,
  // §9.7) — la idempotencia en sí (violación real de la constraint única)
  // no se prueba acá con Prisma mockeado, eso va en integración.
  //
  // `service` no expone el método todavía, así que TypeScript no lo deja
  // llamar directo — en vez de agregar un stub al servicio real (prohibido
  // acá), se declara localmente el contrato esperado y se castea `service`
  // a él solo para que el archivo compile. En runtime, la propiedad no
  // existe: llamar al método lanza un `TypeError` real ("is not a
  // function"), que es la razón correcta de rojo para esta fase — nunca un
  // error de compilación que tumbe también los tests viejos de T3.1/T3.2 de
  // este mismo archivo.
  interface CashRegisterServiceWithMovimientoManual {
    registrarMovimientoManual(
      tx: Prisma.TransactionClient,
      input: {
        sessionId: number;
        // Contrato del ticket T3.3 (spec §4.2): subconjunto de
        // `CashMovementTipo`, expresado como unión de literales — los
        // "enums" que genera Prisma son un `const` + alias de tipo, no un
        // enum real de TS, así que `CashMovementTipo.INGRESO_MANUAL` no se
        // puede usar en posición de tipo (namespace merging no aplica acá).
        tipo: 'INGRESO_MANUAL' | 'RETIRO';
        monto: Prisma.Decimal.Value;
        descripcion: string;
        userId: number;
        idempotencyKey: string;
      },
    ): Promise<{ id: number }>;
  }

  function withMovimientoManual(
    s: CashRegisterService,
  ): CashRegisterServiceWithMovimientoManual {
    return s;
  }

  describe('registrarMovimientoManual (RN-12, §9.7)', () => {
    it('INGRESO_MANUAL: inserta con monto positivo (mismo criterio de signo que registrarMovimiento)', async () => {
      const tx = buildMockTx(buildSessionRow());

      await withMovimientoManual(service).registrarMovimientoManual(asTx(tx), {
        sessionId: 1,
        tipo: CashMovementTipo.INGRESO_MANUAL,
        monto: new Prisma.Decimal('250.00'),
        descripcion: 'Ingreso manual de prueba',
        userId: 7,
        idempotencyKey: 'idem-key-ingreso-1',
      });

      expect(tx.cashMovement.create).toHaveBeenCalledTimes(1);
      const call = tx.cashMovement.create.mock.calls[0][0];
      expect(call.data.monto.toString()).toBe('250');
      expect(call.data.tipo).toBe(CashMovementTipo.INGRESO_MANUAL);
    });

    it('RETIRO: inserta con monto negativo (mismo criterio de signo que registrarMovimiento)', async () => {
      const tx = buildMockTx(buildSessionRow());

      await withMovimientoManual(service).registrarMovimientoManual(asTx(tx), {
        sessionId: 1,
        tipo: CashMovementTipo.RETIRO,
        monto: new Prisma.Decimal('250.00'),
        descripcion: 'Retiro de prueba',
        userId: 7,
        idempotencyKey: 'idem-key-retiro-1',
      });

      expect(tx.cashMovement.create).toHaveBeenCalledTimes(1);
      const call = tx.cashMovement.create.mock.calls[0][0];
      expect(call.data.monto.toString()).toBe('-250');
      expect(call.data.tipo).toBe(CashMovementTipo.RETIRO);
    });

    it('rechaza monto <= 0 (probando 0 y negativo) sin insertar nada', async () => {
      const tx = buildMockTx(buildSessionRow());

      await expect(
        withMovimientoManual(service).registrarMovimientoManual(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.INGRESO_MANUAL,
          monto: new Prisma.Decimal('0.00'),
          descripcion: 'Monto inválido',
          userId: 7,
          idempotencyKey: 'idem-key-cero',
        }),
      ).rejects.toThrow(/mayor a 0/i);

      await expect(
        withMovimientoManual(service).registrarMovimientoManual(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.RETIRO,
          monto: new Prisma.Decimal('-10.00'),
          descripcion: 'Monto inválido',
          userId: 7,
          idempotencyKey: 'idem-key-negativo',
        }),
      ).rejects.toThrow(/mayor a 0/i);

      expect(tx.cashMovement.create).not.toHaveBeenCalled();
    });

    it('rechaza descripcion vacía sin insertar nada', async () => {
      const tx = buildMockTx(buildSessionRow());

      await expect(
        withMovimientoManual(service).registrarMovimientoManual(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.INGRESO_MANUAL,
          monto: new Prisma.Decimal('100.00'),
          descripcion: '',
          userId: 7,
          idempotencyKey: 'idem-key-sin-desc',
        }),
      ).rejects.toThrow(/descripci[oó]n/i);

      expect(tx.cashMovement.create).not.toHaveBeenCalled();
    });

    it('rechaza registrar un ingreso/retiro manual contra una sesión CERRADA sin insertar nada (RN-8, inmutabilidad tras el cierre)', async () => {
      const tx = buildMockTx(
        buildSessionRow({ estado: CashRegisterSessionEstado.CERRADA }),
      );

      await expect(
        withMovimientoManual(service).registrarMovimientoManual(asTx(tx), {
          sessionId: 1,
          tipo: CashMovementTipo.INGRESO_MANUAL,
          monto: new Prisma.Decimal('100.00'),
          descripcion: 'Ingreso contra sesión cerrada',
          userId: 7,
          idempotencyKey: 'idem-key-cerrada',
        }),
      ).rejects.toThrow(/cerrada/i);

      expect(tx.cashMovement.create).not.toHaveBeenCalled();
    });
  });

  // Fase 04a (T3.4) — `cerrarSesion` TODAVÍA NO EXISTE en
  // `CashRegisterService` (se agrega recién en la Fase 04, otra sesión);
  // mismo criterio que `registrarMovimientoManual` en la fase 04a de T3.3:
  // no se agrega ni un stub al servicio real, se declara localmente el
  // contrato esperado (spec §4.2) y se castea para que el archivo compile,
  // dejando que la llamada real lance en runtime (razón correcta de rojo).
  //
  // Umbral (RN-5): comparar la diferencia contra `umbral_diferencia_caja`
  // (sembrado en $500 por T0.13, AMB-10 RESUELTA). El contrato de
  // `cerrarSesion` documentado en la spec (sección 4.2) y en el propio
  // ticket NO recibe ese valor como parte del `input` — se asume acá que la
  // Fase 04 lo resuelve inyectando `SettingsService` en el constructor de
  // `CashRegisterService` (mismo mecanismo que el resto del sistema usa
  // para leer parámetros configurables). Como no se puede tocar el
  // constructor real en esta fase, el servicio de este describe se
  // instancia con un cast local a un constructor de 2 argumentos (prisma,
  // settings) — hoy, antes de la implementación, el argumento extra
  // simplemente se ignora (el constructor real solo toma 1) y
  // `cerrarSesion` sigue sin existir, así que el rojo sigue siendo por la
  // razón correcta (`TypeError: ... is not a function`). **Ambigüedad
  // señalada, no resuelta unilateralmente**: si el diseño real de la
  // Fase 04 difiere de esta asunción (por ejemplo, si el umbral viaja
  // como parte del `input` en vez de por constructor), este bloque va a
  // necesitar un ajuste menor de wiring, sin tocar las aserciones de
  // negocio en sí.
  describe('cerrarSesion (RN-4, RN-5, RN-6, invariante 2)', () => {
    interface CerrarSesionInput {
      sessionId: number;
      montoDeclarado: Prisma.Decimal.Value;
      notaCierre?: string;
      userId: number;
      esOwner: boolean;
    }

    interface CashRegisterSessionForRole extends Omit<
      SessionRow,
      'montoSistema' | 'diferencia'
    > {
      // Mismo patrón que `VariantForRole`/`hideOwnerOnlyFields` en
      // `variants.service.ts` (products/variants): el campo se omite del
      // todo para quien no es OWNER, no se manda en 0 ni en null.
      montoSistema?: Prisma.Decimal;
      diferencia?: Prisma.Decimal;
    }

    interface CashRegisterServiceWithCerrarSesion {
      cerrarSesion(
        tx: Prisma.TransactionClient,
        input: CerrarSesionInput,
      ): Promise<CashRegisterSessionForRole>;
    }

    type CashRegisterServiceConstructorConSettings = new (
      prisma: PrismaService,
      settings: SettingsService,
    ) => CashRegisterServiceWithCerrarSesion;

    // $500.00 — valor real sembrado por T0.13 (AMB-10, RESUELTA), leído acá
    // vía un `SettingsService` mockeado (nunca como un número mágico suelto
    // sin explicar de dónde sale).
    const UMBRAL_DIFERENCIA_CAJA_SEMBRADO = '500.00';

    function buildServiceConSettings(
      umbral: Prisma.Decimal.Value = UMBRAL_DIFERENCIA_CAJA_SEMBRADO,
    ): {
      service: CashRegisterServiceWithCerrarSesion;
      settings: { getDecimal: jest.Mock };
    } {
      const settings = {
        getDecimal: jest.fn().mockResolvedValue(new Prisma.Decimal(umbral)),
      };
      const ServiceConSettings =
        CashRegisterService as unknown as CashRegisterServiceConstructorConSettings;
      const service = new ServiceConSettings(
        {} as PrismaService,
        settings as unknown as SettingsService,
      );
      return { service, settings };
    }

    // Sesión ABIERTA con montoInicial=100 más una suma de movimientos
    // configurable — fixture compartida por los casos de cálculo de abajo.
    function buildTxParaCierre(
      sessionRow: SessionRow | null,
      sumaMovimientos: string,
    ): MockTx {
      const tx = buildMockTx(sessionRow);
      tx.cashMovement.aggregate.mockResolvedValue({
        _sum: { monto: new Prisma.Decimal(sumaMovimientos) },
      });
      return tx;
    }

    function lastUpdateCallData(tx: MockTx): {
      estado?: CashRegisterSessionEstado;
      montoDeclarado?: Prisma.Decimal.Value;
      montoSistema?: Prisma.Decimal.Value;
      diferencia?: Prisma.Decimal.Value;
      notaCierre?: string | null;
    } {
      const call = tx.cashRegisterSession.update.mock.calls[0][0] as {
        data: {
          estado?: CashRegisterSessionEstado;
          montoDeclarado?: Prisma.Decimal.Value;
          montoSistema?: Prisma.Decimal.Value;
          diferencia?: Prisma.Decimal.Value;
          notaCierre?: string | null;
        };
      };
      return call.data;
    }

    it('camino feliz: montoDeclarado == montoSistema calculado → diferencia 0, no exige nota, cierra la sesión (estado CERRADA)', async () => {
      const abierta = buildSessionRow({
        id: 1,
        montoInicial: new Prisma.Decimal('100.00'),
      });
      const tx = buildTxParaCierre(abierta, '400.00'); // montoSistema = 500
      const { service } = buildServiceConSettings();

      await expect(
        service.cerrarSesion(asTx(tx), {
          sessionId: 1,
          montoDeclarado: new Prisma.Decimal('500.00'),
          userId: 7,
          esOwner: true,
        }),
      ).resolves.toBeDefined();

      const data = lastUpdateCallData(tx);
      expect(data.estado).toBe(CashRegisterSessionEstado.CERRADA);
      expect(new Prisma.Decimal(data.montoSistema!).toString()).toBe('500');
      expect(new Prisma.Decimal(data.diferencia!).toString()).toBe('0');
      expect(new Prisma.Decimal(data.montoDeclarado!).toString()).toBe('500');
    });

    it('diferencia por debajo del umbral (ej. $100, umbral $500) sin nota → cierra igual, sin exigir nada', async () => {
      const abierta = buildSessionRow({
        id: 1,
        montoInicial: new Prisma.Decimal('100.00'),
      });
      const tx = buildTxParaCierre(abierta, '400.00'); // montoSistema = 500
      const { service } = buildServiceConSettings();

      await expect(
        service.cerrarSesion(asTx(tx), {
          sessionId: 1,
          montoDeclarado: new Prisma.Decimal('600.00'), // diferencia = 100
          userId: 7,
          esOwner: true,
        }),
      ).resolves.toBeDefined();

      const data = lastUpdateCallData(tx);
      expect(data.estado).toBe(CashRegisterSessionEstado.CERRADA);
      expect(new Prisma.Decimal(data.diferencia!).toString()).toBe('100');
    });

    it('diferencia exactamente igual al umbral ($500), SIN notaCierre, cerrando esOwner: true → rechaza (RN-5, caso límite ">=")', async () => {
      const abierta = buildSessionRow({
        id: 1,
        montoInicial: new Prisma.Decimal('100.00'),
      });
      const tx = buildTxParaCierre(abierta, '400.00'); // montoSistema = 500
      const { service } = buildServiceConSettings();

      await expect(
        service.cerrarSesion(asTx(tx), {
          sessionId: 1,
          montoDeclarado: new Prisma.Decimal('1000.00'), // diferencia = 500
          userId: 7,
          esOwner: true,
        }),
      ).rejects.toThrow(/diferencia/i);

      expect(tx.cashRegisterSession.update).not.toHaveBeenCalled();
    });

    it('misma diferencia de $500 SIN notaCierre, cerrando esOwner: false (SELLER) → NO rechaza, cierra igual (RN-6, cierre a ciegas)', async () => {
      const abierta = buildSessionRow({
        id: 1,
        montoInicial: new Prisma.Decimal('100.00'),
      });
      const tx = buildTxParaCierre(abierta, '400.00'); // montoSistema = 500
      const { service } = buildServiceConSettings();

      await expect(
        service.cerrarSesion(asTx(tx), {
          sessionId: 1,
          montoDeclarado: new Prisma.Decimal('1000.00'), // diferencia = 500
          userId: 7,
          esOwner: false,
        }),
      ).resolves.toBeDefined();

      const data = lastUpdateCallData(tx);
      expect(data.estado).toBe(CashRegisterSessionEstado.CERRADA);
    });

    it('esOwner: true → el resultado devuelto incluye montoSistema y diferencia', async () => {
      const abierta = buildSessionRow({
        id: 1,
        montoInicial: new Prisma.Decimal('100.00'),
      });
      const tx = buildTxParaCierre(abierta, '400.00');
      tx.cashRegisterSession.update.mockResolvedValue({
        ...abierta,
        estado: CashRegisterSessionEstado.CERRADA,
        montoDeclarado: new Prisma.Decimal('500.00'),
        montoSistema: new Prisma.Decimal('500.00'),
        diferencia: new Prisma.Decimal('0.00'),
      });
      const { service } = buildServiceConSettings();

      const result = await service.cerrarSesion(asTx(tx), {
        sessionId: 1,
        montoDeclarado: new Prisma.Decimal('500.00'),
        userId: 7,
        esOwner: true,
      });

      expect(result.montoSistema).toBeDefined();
      expect(result.diferencia).toBeDefined();
      expect(new Prisma.Decimal(result.montoSistema!).toString()).toBe('500');
      expect(new Prisma.Decimal(result.diferencia!).toString()).toBe('0');
    });

    it('esOwner: false → el resultado devuelto OCULTA montoSistema y diferencia (mismo criterio que VariantForRole/hideOwnerOnlyFields)', async () => {
      const abierta = buildSessionRow({
        id: 1,
        montoInicial: new Prisma.Decimal('100.00'),
      });
      const tx = buildTxParaCierre(abierta, '400.00');
      // La fila "cruda" que devolvería Prisma SÍ trae montoSistema/
      // diferencia — la ocultación tiene que ser una decisión activa del
      // servicio, no una casualidad de lo que el mock resolvió.
      tx.cashRegisterSession.update.mockResolvedValue({
        ...abierta,
        estado: CashRegisterSessionEstado.CERRADA,
        montoDeclarado: new Prisma.Decimal('500.00'),
        montoSistema: new Prisma.Decimal('500.00'),
        diferencia: new Prisma.Decimal('0.00'),
      });
      const { service } = buildServiceConSettings();

      const result = await service.cerrarSesion(asTx(tx), {
        sessionId: 1,
        montoDeclarado: new Prisma.Decimal('500.00'),
        userId: 7,
        esOwner: false,
      });

      expect(result.montoSistema).toBeUndefined();
      expect(result.diferencia).toBeUndefined();
    });

    it('rechaza cerrar una sesión que ya está CERRADA', async () => {
      const cerrada = buildSessionRow({
        id: 1,
        estado: CashRegisterSessionEstado.CERRADA,
      });
      const tx = buildTxParaCierre(cerrada, '0.00');
      const { service } = buildServiceConSettings();

      await expect(
        service.cerrarSesion(asTx(tx), {
          sessionId: 1,
          montoDeclarado: new Prisma.Decimal('100.00'),
          userId: 7,
          esOwner: true,
        }),
      ).rejects.toThrow(/cerrada/i);

      expect(tx.cashRegisterSession.update).not.toHaveBeenCalled();
    });

    it('rechaza cerrar una sesión inexistente', async () => {
      const tx = buildTxParaCierre(null, '0.00');
      const { service } = buildServiceConSettings();

      await expect(
        service.cerrarSesion(asTx(tx), {
          sessionId: 999,
          montoDeclarado: new Prisma.Decimal('100.00'),
          userId: 7,
          esOwner: true,
        }),
      ).rejects.toThrow(/no encontrada/i);

      expect(tx.cashRegisterSession.update).not.toHaveBeenCalled();
    });
  });
});
