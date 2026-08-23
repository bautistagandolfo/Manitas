import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

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
}
