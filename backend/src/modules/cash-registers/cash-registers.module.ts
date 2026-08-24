import { Module } from '@nestjs/common';
import { CashRegistersController } from './cash-registers.controller';
import { CashRegisterService } from './cash-register.service';
import { SettingsModule } from '../../common/settings/settings.module';

@Module({
  imports: [SettingsModule],
  controllers: [CashRegistersController],
  providers: [CashRegisterService],
  exports: [CashRegisterService],
})
export class CashRegistersModule {}
