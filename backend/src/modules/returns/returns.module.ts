import { Module } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { StockModule } from '../stock/stock.module';
import { CashRegistersModule } from '../cash-registers/cash-registers.module';
import { SalesModule } from '../sales/sales.module';
import { SettingsModule } from '../../common/settings/settings.module';

@Module({
  imports: [StockModule, CashRegistersModule, SalesModule, SettingsModule],
  controllers: [ReturnsController],
  providers: [ReturnsService],
  exports: [ReturnsService],
})
export class ReturnsModule {}
