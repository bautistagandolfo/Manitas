import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import { CashMovement, CashRegisterSession, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CashRegisterService,
  CashRegisterSessionForRole,
} from './cash-register.service';
import { OpenSessionDto } from './dto/open-session.dto';
import { ManualMovementDto } from './dto/manual-movement.dto';
import { CloseSessionDto } from './dto/close-session.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';
import { IdempotencyInterceptor } from '../../common/idempotency/idempotency.interceptor';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import { withIdempotency } from '../../common/idempotency/idempotency.util';

@Controller('cash-registers')
export class CashRegistersController {
  constructor(
    private readonly cashRegisterService: CashRegisterService,
    private readonly prisma: PrismaService,
  ) {}

  // T3.5 / RN-7: la "detección de sesión olvidada" es del lado del
  // frontend (T3.7) — compara `fechaApertura` contra "hoy" en hora
  // argentina. Este endpoint solo expone la sesión ABIERTA actual (si
  // hay alguna) con su `montoSistema` recalculado en vivo. Sin @Roles:
  // cualquiera necesita poder consultar esto antes de operar.
  @Get('sessions/open')
  async abierta(
    @CurrentUser() user: RequestUser,
  ): Promise<CashRegisterSessionForRole> {
    return this.prisma.$transaction((tx) =>
      this.cashRegisterService.getSesionAbiertaConTotales(
        tx,
        user.rol === UserRole.OWNER,
      ),
    );
  }

  // Ticket nuevo (post Release Candidate) — sugerencia de continuidad
  // entre sesiones (ver el comentario de `obtenerUltimoCierre` en el
  // servicio). Sin @Roles: mismo criterio que abrir la sesión en sí —
  // cualquiera tiene que poder ver esto antes de escribir el monto
  // inicial. `montoDeclarado`, no `montoSistema`/`diferencia`: es el
  // efectivo que alguien ya contó y declaró, no un dato que RN-6 le
  // oculte a un SELLER.
  @Get('sessions/last-closed')
  async ultimoCierre(): Promise<{ montoDeclarado: string | null }> {
    const monto = await this.cashRegisterService.obtenerUltimoCierre();
    return { montoDeclarado: monto?.toString() ?? null };
  }

  // Sin @Roles: abrir una sesión de caja está abierto a cualquier rol
  // autenticado (BLUEPRINT §5.5 — una vendedora tiene que poder arrancar
  // el día sola). RolesGuard corre global (AppModule); sin @Roles() acá,
  // no restringe nada más allá de estar logueado.
  @Post('sessions')
  async abrir(
    @Body() dto: OpenSessionDto,
    @CurrentUser() user: RequestUser,
  ): Promise<CashRegisterSession> {
    return this.prisma.$transaction((tx) =>
      this.cashRegisterService.abrirSesion(tx, {
        montoInicial: dto.montoInicial,
        userId: user.id,
      }),
    );
  }

  // T3.3 / AMB-13 (RESUELTA): OWNER-only — mover efectivo sin comprobante
  // automático detrás es el punto de mayor riesgo de mal uso del módulo.
  // Idempotente (RN-12, §9.7, ejemplo textual del blueprint): el
  // interceptor exige el header y lo deja en el request; withIdempotency
  // envuelve la transacción completa (resolver sesión abierta + insertar)
  // — si la clave ya existe, devuelve la fila original en vez de
  // duplicar.
  @Roles(UserRole.OWNER)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('movements/ingreso')
  async ingreso(
    @Body() dto: ManualMovementDto,
    @CurrentUser() user: RequestUser,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<CashMovement> {
    return withIdempotency(
      () =>
        this.prisma.$transaction(async (tx) => {
          const session =
            await this.cashRegisterService.getSesionAbiertaOrThrow(tx);
          return this.cashRegisterService.registrarMovimientoManual(tx, {
            sessionId: session.id,
            tipo: 'INGRESO_MANUAL',
            monto: dto.monto,
            descripcion: dto.descripcion,
            userId: user.id,
            idempotencyKey,
          });
        }),
      () => this.prisma.cashMovement.findUnique({ where: { idempotencyKey } }),
    );
  }

  // Mismo criterio que `ingreso` — ver comentario de arriba.
  @Roles(UserRole.OWNER)
  @UseInterceptors(IdempotencyInterceptor)
  @Post('movements/retiro')
  async retiro(
    @Body() dto: ManualMovementDto,
    @CurrentUser() user: RequestUser,
    @IdempotencyKey() idempotencyKey: string,
  ): Promise<CashMovement> {
    return withIdempotency(
      () =>
        this.prisma.$transaction(async (tx) => {
          const session =
            await this.cashRegisterService.getSesionAbiertaOrThrow(tx);
          return this.cashRegisterService.registrarMovimientoManual(tx, {
            sessionId: session.id,
            tipo: 'RETIRO',
            monto: dto.monto,
            descripcion: dto.descripcion,
            userId: user.id,
            idempotencyKey,
          });
        }),
      () => this.prisma.cashMovement.findUnique({ where: { idempotencyKey } }),
    );
  }

  // Sin @Roles: "cierre a ciegas" (§5.5, RN-6) — cualquiera puede cerrar
  // declarando el efectivo contado, pero `esOwner` (derivado del rol real
  // de la sesión, nunca de algo que mande el cliente) decide adentro del
  // servicio si se exige nota y si la respuesta incluye montoSistema/
  // diferencia.
  @HttpCode(HttpStatus.OK)
  @Post('sessions/:id/close')
  async cerrar(
    @Param('id', ParseIntPipe) sessionId: number,
    @Body() dto: CloseSessionDto,
    @CurrentUser() user: RequestUser,
  ): Promise<CashRegisterSessionForRole> {
    return this.prisma.$transaction((tx) =>
      this.cashRegisterService.cerrarSesion(tx, {
        sessionId,
        montoDeclarado: dto.montoDeclarado,
        notaCierre: dto.notaCierre,
        userId: user.id,
        esOwner: user.rol === UserRole.OWNER,
      }),
    );
  }
}
