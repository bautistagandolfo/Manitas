import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { UserRole, Variant } from '@prisma/client';
import { VariantsService, VariantForRole } from './variants.service';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { UpdateVariantPriceDto } from './dto/update-variant-price.dto';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';

@Controller()
export class VariantsController {
  constructor(private readonly variantsService: VariantsService) {}

  // OWNER-only (AMB-11, RESUELTA): crear una variante fija su costo
  // inicial. RolesGuard corre global (AppModule) y lee este @Roles() por
  // handler — no hace falta @UseGuards acá. El resto de las rutas de este
  // controller no lo llevan: son de cualquier rol autenticado.
  @Roles(UserRole.OWNER)
  @Post('products/:productId/variants')
  create(
    @Param('productId', ParseIntPipe) productId: number,
    @Body() dto: CreateVariantDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Variant> {
    return this.variantsService.create(productId, dto, user.id);
  }

  @Get('variants/:id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ): Promise<VariantForRole> {
    return this.variantsService.findOne(id, user.rol === UserRole.OWNER);
  }

  @Patch('variants/:id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() user: RequestUser,
  ): Promise<VariantForRole> {
    return this.variantsService.update(id, dto, user.rol === UserRole.OWNER);
  }

  // OWNER-only (AMB-11, RESUELTA). Ruta separada del PATCH de arriba: ver
  // el comentario en variants.service.ts (updatePrice) sobre por qué no es
  // un campo más de UpdateVariantDto.
  @Roles(UserRole.OWNER)
  @Patch('variants/:id/price')
  updatePrice(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateVariantPriceDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Variant> {
    return this.variantsService.updatePrice(id, dto, user.id);
  }
}
