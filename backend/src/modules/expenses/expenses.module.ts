import { Module } from '@nestjs/common';
import { ExpenseCategoriesController } from './expense-categories.controller';
import { ExpenseCategoriesService } from './expense-categories.service';
import { ExpensesController } from './expenses.controller';
import { ExpensesService } from './expenses.service';
import { CashRegistersModule } from '../cash-registers/cash-registers.module';

// T6.1 — ABM de categorías de gasto. Gana `ExpensesController`/
// `ExpensesService` (T6.2/T6.3) y los endpoints de `resultados`
// (T6.4+) más adelante, en el mismo módulo — mismo criterio que
// `products` agrupa marcas/categorías/talles/colores/variantes/
// precios/import bajo un solo `ProductsModule`, todos parte de la
// misma Etapa/frontera de negocio.
//
// T6.2 (Fase 04a, stub): agrega `ExpensesController`/`ExpensesService`
// a los arrays existentes, sin tocar lo de T6.1.
//
// T6.3 (Fase 04a, cambio estructural mínimo): `CashRegistersModule` en
// `imports` — mismo patrón que `ReturnsModule` ya usa para poder
// inyectar `CashRegisterService` en su propio servicio.
@Module({
  imports: [CashRegistersModule],
  controllers: [ExpenseCategoriesController, ExpensesController],
  providers: [ExpenseCategoriesService, ExpensesService],
  exports: [ExpenseCategoriesService, ExpensesService],
})
export class ExpensesModule {}
