import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ExpenseCategory } from '@prisma/client';
import { ExpenseCategoriesService } from './expense-categories.service';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';
import { UpdateExpenseCategoryDto } from './dto/update-expense-category.dto';

// RN-1 (spec sección 2): sin `@Roles` — gestionar categorías de gasto
// no está en la lista de exclusiones de `SELLER` de BLUEPRINT §5.1
// (resultados, usuarios, costos, cierre de caja) — mismo criterio
// exacto que `brands`/`categories` de `products`. La restricción real
// de esta categoría es `bloqueada` (a nivel de servicio), no el rol.
@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(
    private readonly expenseCategoriesService: ExpenseCategoriesService,
  ) {}

  @Get()
  findAll(): Promise<ExpenseCategory[]> {
    return this.expenseCategoriesService.findAll();
  }

  @Post()
  create(@Body() dto: CreateExpenseCategoryDto): Promise<ExpenseCategory> {
    return this.expenseCategoriesService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategory> {
    return this.expenseCategoriesService.update(id, dto);
  }
}
