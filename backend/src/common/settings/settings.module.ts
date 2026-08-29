import { Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';

// T6.9 agrega `SettingsController` (`GET`/`PATCH /settings`, OWNER-only)
// al mismo módulo — hasta acá `SettingsModule` solo exportaba el
// servicio para que `sales`/`returns`/`cash-registers` LEAN valores
// (nunca los modifican); este controller es la única puerta de
// escritura, para la pantalla de configuración.
@Module({
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
