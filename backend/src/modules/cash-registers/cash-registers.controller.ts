import { Body, Controller, Post } from '@nestjs/common';
import { CashRegisterSession } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CashRegisterService } from './cash-register.service';
import { OpenSessionDto } from './dto/open-session.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';

// Sin @Roles: abrir una sesión de caja está abierto a cualquier rol
// autenticado (BLUEPRINT §5.5 — una vendedora tiene que poder arrancar el
// día sola). RolesGuard corre global (AppModule); sin @Roles() acá, no
// restringe nada más allá de estar logueado.
@Controller('cash-registers')
export class CashRegistersController {
  constructor(
    private readonly cashRegisterService: CashRegisterService,
    private readonly prisma: PrismaService,
  ) {}

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
}
