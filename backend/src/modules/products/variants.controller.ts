import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PriceHistory, UserRole, Variant } from '@prisma/client';
import {
  VariantsService,
  VariantForRole,
  VariantSearchResult,
} from './variants.service';
import { CreateVariantDto } from './dto/create-variant.dto';
import { UpdateVariantDto } from './dto/update-variant.dto';
import { UpdateVariantPriceDto } from './dto/update-variant-price.dto';
import { VariantSearchQueryDto } from './dto/variant-search-query.dto';
import { PriceHistoryQueryDto } from './dto/price-history-query.dto';
import { PaginatedResult } from './products.service';
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

  // Antes que `variants/:id` a propósito: Nest/Express matchea rutas en
  // orden de declaración dentro del controller, y `:id` es un parámetro
  // greedy — si esta ruta estática fuera después, "/variants/search"
  // caería en `findOne` con `id = "search"` (400 de ParseIntPipe) en vez
  // de llegar acá.
  @Get('variants/search')
  search(
    @Query() query: VariantSearchQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<PaginatedResult<VariantSearchResult>> {
    return this.variantsService.search(query, user.rol === UserRole.OWNER);
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

  // T2.9 — OWNER-only (RN-3, literal: incluye entradas de COSTO).
  // Distinto de PATCH .../price: acá solo se lee, nunca se escribe.
  @Roles(UserRole.OWNER)
  @Get('variants/:id/price-history')
  getPriceHistory(
    @Param('id', ParseIntPipe) id: number,
    @Query() query: PriceHistoryQueryDto,
  ): Promise<PaginatedResult<PriceHistory>> {
    return this.variantsService.getPriceHistory(id, query);
  }
}
