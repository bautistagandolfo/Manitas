import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CashMovement,
  CashMovementReferenciaTipo,
  CashMovementTipo,
  CashRegisterSession,
  CashRegisterSessionEstado,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { assertPositive } from '../../common/money/money.util';
import { SettingsService } from '../../common/settings/settings.service';
import { SETTINGS_KEYS } from '../../common/settings/settings-keys';

// Único punto del sistema que escribe cash_movements y abre/cierra sesiones
// de caja (mismo principio que CLAUDE.md regla 4 aplica a stock.service.ts).
// Todos los métodos reciben el `tx` de una transacción ya abierta por quien
// llama — nunca abren la suya propia (contrato de
// modulo-cash-registers-spec.md, sección 4.2): en `sales`, el movimiento de
// caja es el último paso dentro de la transacción completa de la venta, no
// una operación aislada.

export interface AbrirSesionInput {
  montoInicial: Prisma.Decimal.Value;
  userId: number;
}

export interface RegistrarMovimientoInput {
  sessionId: number;
  tipo: CashMovementTipo;
  // Siempre POSITIVO (RN-3, spec sección 4.2): el servicio aplica el signo
  // según `tipo`, nunca confía en que quien llama ya lo mande con el signo
  // correcto — así ningún caller puede violar por error el CHECK de la
  // base (cash_movements_monto_sign_check, fase 01).
  monto: Prisma.Decimal.Value;
  referenciaTipo?: CashMovementReferenciaTipo;
  referenciaId?: number;
  descripcion: string;
  userId: number;
  // Opcional: solo lo usa T3.3 (ingreso/retiro manual, RN-12, §9.7). Las
  // filas que genera este módulo automáticamente para sales/returns/
  // expenses (T3.4+) no lo necesitan — esa idempotencia la garantiza la
  // clave de la operación completa (venta/devolución/gasto), no cada
  // movimiento de caja por separado.
  idempotencyKey?: string;
}

export interface RegistrarMovimientoManualInput {
  sessionId: number;
  tipo: 'INGRESO_MANUAL' | 'RETIRO';
  monto: Prisma.Decimal.Value;
  descripcion: string;
  userId: number;
  idempotencyKey: string;
}

export interface CerrarSesionInput {
  sessionId: number;
  montoDeclarado: Prisma.Decimal.Value;
  notaCierre?: string;
  userId: number;
  esOwner: boolean;
}

export interface CashRegisterReconciliationMismatch {
  sessionId: number;
  montoSistemaGuardado: Prisma.Decimal;
  montoSistemaRecalculado: Prisma.Decimal;
}

// RN-6 (§5.1, literal: "SELLER no accede a... cierre de caja con
// totales"): `montoSistema`/`diferencia` se omiten del todo para quien no
// es OWNER, no se mandan en 0 ni en null — mismo patrón que
// `VariantForRole`/`hideOwnerOnlyFields` en `products/variants.service.ts`
// para `costoActual`. Se decide acá (no con un `omit` de Prisma en la
// query) porque la condición es dinámica según quién pregunta.
export type CashRegisterSessionForRole = Omit<
  CashRegisterSession,
  'montoSistema' | 'diferencia'
> & {
  montoSistema?: Prisma.Decimal | null;
  diferencia?: Prisma.Decimal | null;
};

function hideOwnerOnlyFields(
  session: CashRegisterSession,
  isOwner: boolean,
): CashRegisterSessionForRole {
  if (isOwner) {
    return session;
  }
  const stripped: CashRegisterSessionForRole = { ...session };
  delete stripped.montoSistema;
  delete stripped.diferencia;
  return stripped;
}

// VENTA e INGRESO_MANUAL siempre positivos; el resto siempre negativos
// (BLUEPRINT §3.6, RN-3). Mismo CHECK reforzado en la base como defensa en
// profundidad, no como la única barrera.
const TIPOS_POSITIVOS = new Set<CashMovementTipo>([
  CashMovementTipo.VENTA,
  CashMovementTipo.INGRESO_MANUAL,
]);

// Fase 08 (QA adversarial) — hallazgo real: las tres columnas de plata de
// este módulo (`monto_inicial`, `monto_declarado`, `cash_movements.monto`)
// son `Decimal(12, 2)` en la base (máximo absoluto representable
// 9999999999.99). Sin este chequeo, un valor que lo supera no lo rechaza
// ningún DTO (`@IsDecimal` valida formato, no magnitud) ni el servicio —
// llega crudo a Postgres, que lo rechaza con "numeric field overflow"
// (código 22003), un `PrismaClientUnknownRequestError` sin `.code`
// traducible como P2002/P2003 — el `GlobalExceptionFilter` no tiene forma
// de distinguirlo de cualquier otro fallo interno y responde 500 genérico.
// Validar acá, antes de tocar Prisma, evita el 500 igual que
// `assertPositive`/`isNegative()` evitan el `CHECK` crudo de la base.
const MAX_MONTO_ABSOLUTO = new Prisma.Decimal('9999999999.99');

function assertDentroDePrecision(
  value: Prisma.Decimal.Value,
  field: string,
): void {
  if (new Prisma.Decimal(value).abs().greaterThan(MAX_MONTO_ABSOLUTO)) {
    throw new BadRequestException(`${field} es demasiado grande`);
  }
}

@Injectable()
export class CashRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // Ticket nuevo (post Release Candidate) — hallazgo real de una
  // conversación con el usuario: nada en el sistema conectaba el
  // `monto_declarado` con el que cerró la última sesión con el
  // `monto_inicial` de la siguiente — dos sesiones sin ninguna relación
  // entre sí, ni siquiera una sugerencia. En un arqueo de caja real, el
  // efectivo con el que cierra un turno ES el efectivo con el que abre
  // el próximo (salvo un ingreso/retiro que lo explique) — confirmado
  // con el usuario, que además confirmó que no quiere bloquear la
  // apertura si no coincide (sigue siendo "cierre a ciegas": no todo
  // rol ve `diferencia`, y forzar una coincidencia exacta acá
  // implicaría revelarla). Se limita a SUGERIR: la última sesión
  // CERRADA (por `fechaCierre`, no por id — no hay ninguna garantía de
  // que los ids crezcan en el mismo orden que las fechas en un sistema
  // real) y su `monto_declarado`. `null` la primera vez que se abre
  // caja en la vida del sistema (nunca hubo una sesión cerrada antes).
  async obtenerUltimoCierre(): Promise<Prisma.Decimal | null> {
    const ultima = await this.prisma.cashRegisterSession.findFirst({
      where: { estado: CashRegisterSessionEstado.CERRADA },
      orderBy: { fechaCierre: 'desc' },
      select: { montoDeclarado: true },
    });
    return ultima?.montoDeclarado ?? null;
  }

  // RN-1 / invariante 9: no hay lógica de exclusión acá — el índice único
  // parcial `cash_register_sessions_one_open_key` (fase 01) es la barrera
  // real. Este método solo valida `montoInicial` y traduce la violación de
  // esa constraint a un mensaje de negocio.
  async abrirSesion(
    tx: Prisma.TransactionClient,
    input: AbrirSesionInput,
  ): Promise<CashRegisterSession> {
    if (new Prisma.Decimal(input.montoInicial).isNegative()) {
      throw new BadRequestException('El monto inicial no puede ser negativo');
    }
    assertDentroDePrecision(input.montoInicial, 'El monto inicial');

    try {
      return await tx.cashRegisterSession.create({
        data: {
          fechaApertura: new Date(),
          userIdApertura: input.userId,
          montoInicial: input.montoInicial,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya hay una sesión de caja abierta');
      }
      throw error;
    }
  }

  // RN-3 (signo) + RN-8 (inmutabilidad tras el cierre) + sección 5 de la
  // spec (concurrencia): bloquea la fila de la sesión ANTES de leer su
  // `estado` — mismo patrón que BLUEPRINT §9.4 exige para stock, aplicado
  // acá a una fila de sesión en vez de una de variante. Sin este lock, un
  // movimiento y un cierre concurrentes podrían intercalarse dejando un
  // movimiento insertado contra una sesión que ya terminó CERRADA.
  async registrarMovimiento(
    tx: Prisma.TransactionClient,
    input: RegistrarMovimientoInput,
  ): Promise<CashMovement> {
    assertPositive(input.monto, 'monto');
    assertDentroDePrecision(input.monto, 'El monto');
    if (!input.descripcion.trim()) {
      throw new BadRequestException(
        'Ingresá una descripción para el movimiento',
      );
    }

    await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
    const session = await tx.cashRegisterSession.findUniqueOrThrow({
      where: { id: input.sessionId },
    });

    if (session.estado !== CashRegisterSessionEstado.ABIERTA) {
      throw new ConflictException('La sesión de caja ya está cerrada');
    }

    const signo = TIPOS_POSITIVOS.has(input.tipo) ? 1 : -1;
    const montoConSigno = new Prisma.Decimal(input.monto).times(signo);

    return tx.cashMovement.create({
      data: {
        sessionId: input.sessionId,
        fecha: new Date(),
        tipo: input.tipo,
        monto: montoConSigno,
        referenciaTipo: input.referenciaTipo,
        referenciaId: input.referenciaId,
        descripcion: input.descripcion,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  // T3.3 / RN-12 / §9.7: ingreso manual y retiro de efectivo, los dos
  // tipos que no vienen de una venta/devolución/gasto — alguien los carga
  // a mano, sin ítem ni comprobante automático detrás. Es el ejemplo
  // textual del blueprint para idempotencia ("un doble click en un retiro
  // de $50.000..."), por eso exige `idempotencyKey` (a diferencia de
  // `registrarMovimiento`, donde es opcional). La detección de la clave
  // duplicada (P2002 sobre `idempotency_key`) la maneja quien llama
  // (`withIdempotency`, T0.14) envolviendo esta llamada — acá solo se
  // reusa toda la lógica de `registrarMovimiento` (signo, lock de sesión,
  // inmutabilidad tras el cierre) sin duplicarla.
  async registrarMovimientoManual(
    tx: Prisma.TransactionClient,
    input: RegistrarMovimientoManualInput,
  ): Promise<CashMovement> {
    return this.registrarMovimiento(tx, {
      sessionId: input.sessionId,
      tipo: input.tipo,
      monto: input.monto,
      descripcion: input.descripcion,
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  private async buscarSesionAbierta(
    tx: Prisma.TransactionClient,
  ): Promise<CashRegisterSession | null> {
    return tx.cashRegisterSession.findFirst({
      where: { estado: CashRegisterSessionEstado.ABIERTA },
    });
  }

  // Usado por este módulo (T3.3, T3.4) y por sales/returns/expenses
  // (módulos futuros, RN-10/RN-11) antes de operar — invariante 10. 409:
  // pensado para una operación de negocio que no puede seguir sin sesión
  // abierta, no para el endpoint de lectura (ver
  // `getSesionAbiertaConTotales`, que usa 404 — semántica distinta para
  // un GET cuyo propósito es justamente chequear si hay una).
  async getSesionAbiertaOrThrow(
    tx: Prisma.TransactionClient,
  ): Promise<CashRegisterSession> {
    const session = await this.buscarSesionAbierta(tx);

    if (!session) {
      throw new ConflictException('No hay una sesión de caja abierta');
    }

    return session;
  }

  // T3.5 / RN-7 / invariante 2 ("recalculable en cualquier momento,
  // también con la sesión abierta"). A diferencia de la fila cruda que
  // `getSesionAbiertaOrThrow` devuelve (con `montoSistema`/`diferencia`
  // en null hasta el cierre, columnas que solo se escriben en
  // `cerrarSesion`), acá se calcula `montoSistema` en vivo —
  // `montoInicial + SUM(cash_movements.monto)` — mismo cálculo que un
  // cierre real haría en este instante. `diferencia` no aplica a una
  // sesión todavía abierta (no hay `montoDeclarado` todavía) y queda tal
  // cual está en la fila (null). Ocultamiento de `montoSistema` para
  // quien no es OWNER, mismo patrón que `cerrarSesion` (RN-6).
  async getSesionAbiertaConTotales(
    tx: Prisma.TransactionClient,
    esOwner: boolean,
  ): Promise<CashRegisterSessionForRole> {
    const session = await this.buscarSesionAbierta(tx);

    if (!session) {
      throw new NotFoundException('No hay ninguna sesión de caja abierta');
    }

    const sum = await tx.cashMovement.aggregate({
      where: { sessionId: session.id },
      _sum: { monto: true },
    });
    const montoSistema = session.montoInicial.plus(
      sum._sum.monto ?? new Prisma.Decimal(0),
    );

    return hideOwnerOnlyFields({ ...session, montoSistema }, esOwner);
  }

  // T3.4 / RN-4, RN-5, RN-6 / invariante 2. Mismo lock que
  // `registrarMovimiento` (sección 5 de la spec): bloquea la fila de
  // sesión ANTES de sumar los movimientos, para que un movimiento y un
  // cierre concurrentes no puedan dejar `monto_sistema` calculado sin ver
  // un movimiento que sí terminó insertado (o viceversa).
  async cerrarSesion(
    tx: Prisma.TransactionClient,
    input: CerrarSesionInput,
  ): Promise<CashRegisterSessionForRole> {
    // Fase 08 — hallazgo real: nada validaba `montoDeclarado` (el efectivo
    // que la persona contó y declara al cerrar) antes de esta fase. Mismo
    // principio físico que ya aplica a `montoInicial` (sección 6 de la
    // spec, "no tiene sentido físico empezar el día con -$500 en el
    // cajón") — contar efectivo negativo tampoco tiene sentido, y sin este
    // chequeo el sistema aceptaba el cierre igual, calculando una
    // `diferencia` sin ningún significado real. Validado antes de tomar el
    // lock de la sesión: es un error del input, no depende de su estado.
    if (new Prisma.Decimal(input.montoDeclarado).isNegative()) {
      throw new BadRequestException(
        'El efectivo contado no puede ser negativo',
      );
    }
    assertDentroDePrecision(input.montoDeclarado, 'El efectivo contado');

    await tx.$queryRaw`SELECT id FROM cash_register_sessions WHERE id = ${input.sessionId} FOR UPDATE`;
    const session = await tx.cashRegisterSession.findUnique({
      where: { id: input.sessionId },
    });

    if (!session) {
      throw new NotFoundException('Sesión de caja no encontrada');
    }
    if (session.estado !== CashRegisterSessionEstado.ABIERTA) {
      throw new ConflictException('La sesión de caja ya está cerrada');
    }

    const sum = await tx.cashMovement.aggregate({
      where: { sessionId: input.sessionId },
      _sum: { monto: true },
    });
    const montoSistema = session.montoInicial.plus(
      sum._sum.monto ?? new Prisma.Decimal(0),
    );
    const montoDeclarado = new Prisma.Decimal(input.montoDeclarado);
    const diferencia = montoDeclarado.minus(montoSistema);
    const notaCierre = input.notaCierre?.trim() || null;

    // RN-5: la nota solo es obligatoria cuando cierra un OWNER — exigírsela
    // a un SELLER revelaría que existe una diferencia, justo lo que RN-6
    // le oculta (§5.5, literal).
    if (input.esOwner) {
      const umbral = await this.settings.getDecimal(
        SETTINGS_KEYS.UMBRAL_DIFERENCIA_CAJA,
      );
      if (diferencia.abs().greaterThanOrEqualTo(umbral) && !notaCierre) {
        throw new BadRequestException(
          `La diferencia es de $${diferencia.abs().toString()}: agregá una nota explicando qué pasó`,
        );
      }
    }

    const updated = await tx.cashRegisterSession.update({
      where: { id: input.sessionId },
      data: {
        estado: CashRegisterSessionEstado.CERRADA,
        fechaCierre: new Date(),
        userIdCierre: input.userId,
        montoDeclarado,
        montoSistema,
        diferencia,
        notaCierre,
      },
    });

    return hideOwnerOnlyFields(updated, input.esOwner);
  }

  // T3.6 — invariante 2 (BLUEPRINT §6.2): monto_sistema == monto_inicial +
  // SUM(cash_movements.monto) para cada sesión CERRADA. Solo sesiones
  // CERRADA: una ABIERTA no tiene monto_sistema persistido contra el cual
  // comparar (eso se recalcula en vivo, ver getSesionAbiertaConTotales).
  // Devuelve solo las que no cuadran — vacío significa reconciliado.
  //
  // Única excepción al contrato de "el servicio nunca abre su propia
  // transacción" (sección 4.2 de la spec): es de solo lectura, no compone
  // con la transacción de nadie más. REPEATABLE READ, mismo motivo que
  // stock.service.reconciliar() (T2.8): sin eso, una escritura real entre
  // las dos lecturas (un cierre concurrente, por ejemplo) podría reportar
  // un desajuste que en realidad nunca existió.
  async reconciliar(): Promise<CashRegisterReconciliationMismatch[]> {
    const [sessions, sums] = await this.prisma.$transaction(
      (tx) =>
        Promise.all([
          tx.cashRegisterSession.findMany({
            where: { estado: CashRegisterSessionEstado.CERRADA },
            select: { id: true, montoInicial: true, montoSistema: true },
          }),
          tx.cashMovement.groupBy({
            by: ['sessionId'],
            _sum: { monto: true },
          }),
        ]),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const sumaPorSesion = new Map(
      sums.map((s) => [s.sessionId, s._sum.monto ?? new Prisma.Decimal(0)]),
    );

    return sessions
      .map((session) => ({
        sessionId: session.id,
        montoSistemaGuardado: session.montoSistema ?? new Prisma.Decimal(0),
        montoSistemaRecalculado: session.montoInicial.plus(
          sumaPorSesion.get(session.id) ?? new Prisma.Decimal(0),
        ),
      }))
      .filter((m) => !m.montoSistemaGuardado.equals(m.montoSistemaRecalculado));
  }
}
