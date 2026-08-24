import { Module } from '@nestjs/common';
import { CashRegistersController } from './cash-registers.controller';
import { CashRegisterService } from './cash-register.service';

@Module({
  controllers: [CashRegistersController],
  providers: [CashRegisterService],
  exports: [CashRegisterService],
})
export class CashRegistersModule {}
