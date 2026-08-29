import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { Setting, UserRole } from '@prisma/client';
import { SettingsService } from './settings.service';
import { UpdateSettingDto } from './dto/update-setting.dto';
import { CurrentUser } from '../auth/current-user.decorator';
import { Roles } from '../auth/roles.decorator';
import type { RequestUser } from '../auth/authenticated-request';

// T6.9 — BLUEPRINT §3.8, literal: "Solo OWNER los modifica." La lectura
// también queda OWNER-only acá: el ticket ("Pantalla de configuración,
// solo OWNER") cubre la pantalla entera, no solo el guardado, y no hay
// ningún otro consumidor de esta ruta HTTP (`sales`/`returns`/
// `cash-registers` leen los valores directo de `SettingsService`, nunca
// por acá — esta ruta es específicamente la pantalla de administración).
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Roles(UserRole.OWNER)
  @Get()
  findAll(): Promise<Setting[]> {
    return this.settingsService.findAll();
  }

  @Roles(UserRole.OWNER)
  @Patch(':clave')
  update(
    @Param('clave') clave: string,
    @Body() dto: UpdateSettingDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Setting> {
    return this.settingsService.setValor(clave, dto.valor, user.id);
  }
}
