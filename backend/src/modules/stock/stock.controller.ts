import { Body, Controller, NotFoundException, Post } from '@nestjs/common';
import { UserRole, Variant } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StockService } from './stock.service';
import { CreateAjusteDto } from './dto/create-ajuste.dto';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';

// OWNER-only (RN-5, literal: "permitido solo a OWNER, con motivo
// obligatorio" — BLUEPRINT §5.2). A diferencia de products/variants, acá
// no hay ninguna acción abierta a SELLER: todo el controller es de un
// solo rol.
@Roles(UserRole.OWNER)
@Controller('stock')
export class StockController {
  constructor(
    private readonly stockService: StockService,
    private readonly prisma: PrismaService,
  ) {}

  // stock.service nunca abre su propia transacción (contrato de
  // modulo-products-variants-spec.md, sección 4.2) — acá es donde se abre,
  // igual que en `sales` el ajuste sería un paso más dentro de la
  // transacción completa de la venta.
  //
  // Existencia de la variante verificada acá, no en stock.service: el
  // servicio confía en recibir un variantId válido (sus tests de la fase
  // 04a nunca cubrieron el caso contrario) y, sin este chequeo, un id
  // inexistente terminaba en un error crudo de Prisma (P2003 o P2025) sin
  // traducir — 500 en vez del 404 que le corresponde a la capa HTTP.
  @Post('ajustes')
  async ajustar(
    @Body() dto: CreateAjusteDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Variant> {
    return this.prisma.$transaction(async (tx) => {
      const variant = await tx.variant.findUnique({
        where: { id: dto.variantId },
      });
      if (!variant) {
        throw new NotFoundException('Variante no encontrada');
      }

      await this.stockService.registrarAjuste(tx, {
        variantId: dto.variantId,
        delta: dto.delta,
        motivo: dto.motivo,
        userId: user.id,
      });
      return tx.variant.findUniqueOrThrow({ where: { id: dto.variantId } });
    });
  }
}
