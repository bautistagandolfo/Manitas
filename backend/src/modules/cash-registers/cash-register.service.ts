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

@Injectable()
export class CashRegisterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

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
}
