import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Size } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateSizeDto } from './dto/create-size.dto';
import { UpdateSizeDto } from './dto/update-size.dto';

@Injectable()
export class SizesService {
  constructor(private readonly prisma: PrismaService) {}

  // Por `orden`, no alfabético — es el motivo por el que este campo existe
  // (BLUEPRINT §3.2): S, M, L, XL en ese orden, no "L, M, S, XL".
  findAll(): Promise<Size[]> {
    return this.prisma.size.findMany({ orderBy: { orden: 'asc' } });
  }

  async create(dto: CreateSizeDto): Promise<Size> {
    try {
      return await this.prisma.size.create({
        data: { nombre: dto.nombre, orden: dto.orden },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un talle con ese nombre');
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateSizeDto): Promise<Size> {
    try {
      return await this.prisma.size.update({ where: { id }, data: dto });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un talle con ese nombre');
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Talle no encontrado');
      }
      throw error;
    }
  }
}
