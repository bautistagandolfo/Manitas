import { Module } from '@nestjs/common';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';
import { SizesController } from './sizes.controller';
import { SizesService } from './sizes.service';
import { ColorsController } from './colors.controller';
import { ColorsService } from './colors.service';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { VariantsController } from './variants.controller';
import { VariantsService } from './variants.service';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';

@Module({
  controllers: [
    BrandsController,
    CategoriesController,
    SizesController,
    ColorsController,
    ProductsController,
    VariantsController,
    PricesController,
  ],
  providers: [
    BrandsService,
    CategoriesService,
    SizesService,
    ColorsService,
    ProductsService,
    VariantsService,
    PricesService,
  ],
})
export class ProductsModule {}
