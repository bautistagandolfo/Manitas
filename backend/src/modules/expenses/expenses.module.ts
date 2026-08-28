import { Module } from '@nestjs/common';
import { ExpenseCategoriesController } from './expense-categories.controller';
import { ExpenseCategoriesService } from './expense-categories.service';

// T6.1 — ABM de categorías de gasto. Gana `ExpensesController`/
// `ExpensesService` (T6.2/T6.3) y los endpoints de `resultados`
// (T6.4+) más adelante, en el mismo módulo — mismo criterio que
// `products` agrupa marcas/categorías/talles/colores/variantes/
// precios/import bajo un solo `ProductsModule`, todos parte de la
// misma Etapa/frontera de negocio.
@Module({
  controllers: [ExpenseCategoriesController],
  providers: [ExpenseCategoriesService],
  exports: [ExpenseCategoriesService],
})
export class ExpensesModule {}
