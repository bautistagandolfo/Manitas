import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller';
import { SalesService } from './sales.service';
import { StockModule } from '../stock/stock.module';
import { CashRegistersModule } from '../cash-registers/cash-registers.module';
import { SettingsModule } from '../../common/settings/settings.module';

@Module({
  imports: [StockModule, CashRegistersModule, SettingsModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}
