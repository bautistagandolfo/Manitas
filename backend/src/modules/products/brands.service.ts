import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Brand, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { esNombreDuplicado } from '../../common/text/normalize-for-comparison';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';

@Injectable()
export class BrandsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Brand[]> {
    return this.prisma.brand.findMany({ orderBy: { nombre: 'asc' } });
  }

  async create(dto: CreateBrandDto): Promise<Brand> {
    // Ticket nuevo (post Release Candidate) — mismo hallazgo real que
    // `colors.service.ts` (verificado en vivo ahí): sin esto, "nike"
    // cuando ya existe "Nike" se crea como una marca nueva y distinta,
    // sin ningún aviso. El catch de P2002 de abajo sigue como red de
    // contención para una carrera genuina, no como el camino principal.
    const existentes = await this.prisma.brand.findMany({
      select: { nombre: true },
    });
    if (
      esNombreDuplicado(
        dto.nombre,
        existentes.map((b) => b.nombre),
      )
    ) {
      throw new ConflictException('Ya existe una marca con ese nombre');
    }
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
    // Ticket nuevo — mismo chequeo que `create`, para renombrar.
    if (dto.nombre !== undefined) {
      const otras = await this.prisma.brand.findMany({
        where: { id: { not: id } },
        select: { nombre: true },
      });
      if (
        esNombreDuplicado(
          dto.nombre,
          otras.map((b) => b.nombre),
        )
      ) {
        throw new ConflictException('Ya existe una marca con ese nombre');
      }
    }
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
