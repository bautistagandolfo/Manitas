import {
  BadRequestException,
  ConflictException,
  Injectable,
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

// VENTA e INGRESO_MANUAL siempre positivos; el resto siempre negativos
// (BLUEPRINT §3.6, RN-3). Mismo CHECK reforzado en la base como defensa en
// profundidad, no como la única barrera.
const TIPOS_POSITIVOS = new Set<CashMovementTipo>([
  CashMovementTipo.VENTA,
  CashMovementTipo.INGRESO_MANUAL,
]);

@Injectable()
export class CashRegisterService {
  constructor(private readonly prisma: PrismaService) {}

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

  // Usado por este módulo (T3.3, T3.4) y por sales/returns/expenses
  // (módulos futuros, RN-10/RN-11) antes de operar — invariante 10.
  async getSesionAbiertaOrThrow(
    tx: Prisma.TransactionClient,
  ): Promise<CashRegisterSession> {
    const session = await tx.cashRegisterSession.findFirst({
      where: { estado: CashRegisterSessionEstado.ABIERTA },
    });

    if (!session) {
      throw new ConflictException('No hay una sesión de caja abierta');
    }

    return session;
  }
}
