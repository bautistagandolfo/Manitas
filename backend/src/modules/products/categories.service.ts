import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Category, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { esNombreDuplicado } from '../../common/text/normalize-for-comparison';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Category[]> {
    return this.prisma.category.findMany({ orderBy: { nombre: 'asc' } });
  }

  async create(dto: CreateCategoryDto): Promise<Category> {
    // Ticket nuevo (post Release Candidate) — mismo hallazgo real que
    // `colors.service.ts` (verificado en vivo ahí). El catch de P2002
    // de abajo sigue como red de contención para una carrera genuina,
    // no como el camino principal.
    const existentes = await this.prisma.category.findMany({
      select: { nombre: true },
    });
    if (
      esNombreDuplicado(
        dto.nombre,
        existentes.map((c) => c.nombre),
      )
    ) {
      throw new ConflictException('Ya existe una categoría con ese nombre');
    }
    try {
      return await this.prisma.category.create({
        data: { nombre: dto.nombre },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe una categoría con ese nombre');
      }
      throw error;
    }
  }

  async update(id: number, dto: UpdateCategoryDto): Promise<Category> {
    // Ticket nuevo — mismo chequeo que `create`, para renombrar.
    if (dto.nombre !== undefined) {
      const otras = await this.prisma.category.findMany({
        where: { id: { not: id } },
        select: { nombre: true },
      });
      if (
        esNombreDuplicado(
          dto.nombre,
          otras.map((c) => c.nombre),
        )
      ) {
        throw new ConflictException('Ya existe una categoría con ese nombre');
      }
    }
    try {
      return await this.prisma.category.update({ where: { id }, data: dto });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe una categoría con ese nombre');
      }
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Categoría no encontrada');
      }
      throw error;
    }
  }
}
