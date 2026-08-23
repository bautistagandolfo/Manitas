import { Module } from '@nestjs/common';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { SizesController } from './sizes.controller';
import { SizesService } from './sizes.service';
import { ColorsController } from './colors.controller';
import { ColorsService } from './colors.service';

@Module({
  controllers: [
    BrandsController,
    CategoriesController,
    SizesController,
    ColorsController,
  ],
  providers: [BrandsService, CategoriesService, SizesService, ColorsService],
})
export class ProductsModule {}
