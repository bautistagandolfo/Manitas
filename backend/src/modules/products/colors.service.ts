import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Color, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateColorDto } from './dto/create-color.dto';
import { UpdateColorDto } from './dto/update-color.dto';

@Injectable()
export class ColorsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Color[]> {
    return this.prisma.color.findMany({ orderBy: { nombre: 'asc' } });
  }

  async create(dto: CreateColorDto): Promise<Color> {
    try {
      return await this.prisma.color.create({ data: { nombre: dto.nombre } });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un color con ese nombre');
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateColorDto): Promise<Color> {
    try {
      return await this.prisma.color.update({ where: { id }, data: dto });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un color con ese nombre');
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Color no encontrado');
      }
      throw error;
    }
  }
}
