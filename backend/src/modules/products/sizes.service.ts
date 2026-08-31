import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Size } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { esNombreDuplicado } from '../../common/text/normalize-for-comparison';
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
    // Ticket nuevo (post Release Candidate) — mismo hallazgo real que
    // `colors.service.ts` (verificado en vivo ahí). Aplica igual con
    // talles numéricos ("1" vs " 1" con espacio, aunque acá el riesgo
    // real es mayúsculas en talles con letra: "s" vs "S"). El catch de
    // P2002 de abajo sigue como red de contención para una carrera
    // genuina, no como el camino principal.
    const existentes = await this.prisma.size.findMany({
      select: { nombre: true },
    });
    if (
      esNombreDuplicado(
        dto.nombre,
        existentes.map((s) => s.nombre),
      )
    ) {
      throw new ConflictException('Ya existe un talle con ese nombre');
    }
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
    // Ticket nuevo — mismo chequeo que `create`, para renombrar.
    if (dto.nombre !== undefined) {
      const otros = await this.prisma.size.findMany({
        where: { id: { not: id } },
        select: { nombre: true },
      });
      if (
        esNombreDuplicado(
          dto.nombre,
          otros.map((s) => s.nombre),
        )
      ) {
        throw new ConflictException('Ya existe un talle con ese nombre');
      }
    }
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
