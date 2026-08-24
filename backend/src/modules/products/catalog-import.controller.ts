import { Body, Controller, Post } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CatalogImportService, ImportResult } from './catalog-import.service';
import { ImportCatalogDto } from './dto/import-catalog.dto';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';

// T2.13/AMB-12 (RESUELTA) — OWNER-only: toda fila fija un costo inicial,
// mismo motivo que create()/createGrid() de variants.
@Roles(UserRole.OWNER)
@Controller('products/import')
export class CatalogImportController {
  constructor(private readonly catalogImportService: CatalogImportService) {}

  @Post()
  import(
    @Body() dto: ImportCatalogDto,
    @CurrentUser() user: RequestUser,
  ): Promise<ImportResult> {
    return this.catalogImportService.import(dto, user.id);
  }
}
