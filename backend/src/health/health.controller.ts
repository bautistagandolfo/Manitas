import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/auth/public.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  // Pública: la golpean UptimeRobot, el healthcheck de Render y Docker sin
  // ninguna sesión (BLUEPRINT §9.10).
  @Public()
  @Get()
  async check(): Promise<{ status: 'ok'; database: 'up' }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new HttpException(
        { status: 'error', database: 'down' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { status: 'ok', database: 'up' };
  }

  // TEMPORAL — verificación manual de Sentry contra producción real, se
  // borra en el commit siguiente apenas se confirma.
  @Public()
  @Get('debug-sentry')
  getError(): void {
    throw new Error(
      'Prueba manual de Sentry en producción — verificación de deploy',
    );
  }
}
