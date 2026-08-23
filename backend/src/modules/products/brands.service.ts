import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Brand, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Brand[]> {
    return this.prisma.brand.findMany({ orderBy: { nombre: 'asc' } });
  }

  async create(dto: CreateBrandDto): Promise<Brand> {
    try {
      return await this.prisma.brand.create({ data: { nombre: dto.nombre } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe una marca con ese nombre');
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateBrandDto): Promise<Brand> {
    try {
      return await this.prisma.brand.update({ where: { id }, data: dto });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe una marca con ese nombre');
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Marca no encontrada');
      }
      throw error;
    }
  }
}
