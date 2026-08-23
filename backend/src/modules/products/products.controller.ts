import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Product, UserRole } from '@prisma/client';
import {
  ProductsService,
  PaginatedResult,
  ProductWithVariants,
} from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { RequestUser } from '../../common/auth/authenticated-request';

// Sin @Roles: crear/editar productos no está en la lista de exclusiones de
// SELLER de BLUEPRINT §5.1 — alcanza con estar autenticado (mismo
// razonamiento que brands/categories/sizes/colors, T2.1).
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  findAll(@Query() query: ProductQueryDto): Promise<PaginatedResult<Product>> {
    return this.productsService.findAll(query);
  }

  @Get(':id')
  findOne(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: RequestUser,
  ): Promise<ProductWithVariants> {
    return this.productsService.findOne(id, user.rol === UserRole.OWNER);
  }

  @Post()
  create(@Body() dto: CreateProductDto): Promise<Product> {
    return this.productsService.create(dto);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProductDto,
  ): Promise<Product> {
    return this.productsService.update(id, dto);
  }
}
