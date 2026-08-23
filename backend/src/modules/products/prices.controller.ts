import { Body, Controller, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PricesService, BulkPriceUpdateItem } from './prices.service';
import { BulkPriceUpdateDto } from './dto/bulk-price-update.dto';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';

// OWNER-only entero (RN-9, literal: "Solo OWNER" — A5). Sin `Idempotency-Key`
// en `apply`: ver el comentario en prices.service.ts.
@Roles(UserRole.OWNER)
@Controller('prices/bulk-update')
export class PricesController {
  constructor(private readonly pricesService: PricesService) {}

  @Post('preview')
  preview(@Body() dto: BulkPriceUpdateDto): Promise<BulkPriceUpdateItem[]> {
    return this.pricesService.preview(dto);
  }

  @Post('apply')
  apply(
    @Body() dto: BulkPriceUpdateDto,
    @CurrentUser() user: RequestUser,
  ): Promise<BulkPriceUpdateItem[]> {
    return this.pricesService.apply(dto, user.id);
  }
}
