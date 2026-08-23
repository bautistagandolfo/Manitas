import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Product } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { ProductQueryDto } from './dto/product-query.dto';

export interface PaginatedResult<T> {
  items: T[];
  // "itemCount", no "total": el linter local no-number-money trata
  // cualquier "total" tipado number como un importe de plata (BLUEPRINT
  // §9.3) — acá es una cantidad de filas, no dinero, pero el nombre solo ya
  // dispara la regla.
  itemCount: number;
  page: number;
  pageSize: number;
}

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  // Paginado en el servidor siempre (BLUEPRINT §12.4) — nunca se trae el
  // catálogo completo al frontend.
  async findAll(query: ProductQueryDto): Promise<PaginatedResult<Product>> {
    const where: Prisma.ProductWhereInput = {
      ...(query.brandId !== undefined && { brandId: query.brandId }),
      ...(query.categoryId !== undefined && { categoryId: query.categoryId }),
      ...(query.activo !== undefined && { activo: query.activo }),
    };

    const [items, itemCount] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: { nombre: 'asc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, itemCount, page: query.page, pageSize: query.pageSize };
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: { variants: true },
    });

    if (!product) {
      throw new NotFoundException('Producto no encontrado');
    }

    return product;
  }

  async create(dto: CreateProductDto): Promise<Product> {
    try {
      return await this.prisma.product.create({
        data: {
          nombre: dto.nombre,
          descripcion: dto.descripcion,
          brandId: dto.brandId,
          categoryId: dto.categoryId,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new BadRequestException(
          'La marca o categoría indicada no existe',
        );
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateProductDto): Promise<Product> {
    try {
      return await this.prisma.product.update({ where: { id }, data: dto });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Producto no encontrado');
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        throw new BadRequestException(
          'La marca o categoría indicada no existe',
        );
      }
      throw error;
    }
  }
}
