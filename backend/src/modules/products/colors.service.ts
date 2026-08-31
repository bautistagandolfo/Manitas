import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Color, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { esNombreDuplicado } from '../../common/text/normalize-for-comparison';
import { CreateColorDto } from './dto/create-color.dto';
import { UpdateColorDto } from './dto/update-color.dto';

@Injectable()
export class ColorsService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<Color[]> {
    return this.prisma.color.findMany({ orderBy: { nombre: 'asc' } });
  }

  async create(dto: CreateColorDto): Promise<Color> {
    // Ticket nuevo (post Release Candidate) — hallazgo real, verificado
    // en vivo: "negro" cuando ya existía "Negro" se creaba como un
    // color nuevo y distinto (201), sin ningún aviso — el `@unique` de
    // Postgres es case-sensitive. Este chequeo cubre mayúsculas Y
    // acentos (colores del rubro como "Bordó"/"Café"/"Marrón"); el
    // catch de P2002 de abajo sigue como red de contención para una
    // carrera genuina, no como el camino principal.
    const existentes = await this.prisma.color.findMany({
      select: { nombre: true },
    });
    if (
      esNombreDuplicado(
        dto.nombre,
        existentes.map((c) => c.nombre),
      )
    ) {
      throw new ConflictException('Ya existe un color con ese nombre');
    }
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
    // Ticket nuevo — mismo chequeo que `create`, para renombrar. Excluye
    // la propia fila para no chocar contra sí misma.
    if (dto.nombre !== undefined) {
      const otros = await this.prisma.color.findMany({
        where: { id: { not: id } },
        select: { nombre: true },
      });
      if (
        esNombreDuplicado(
          dto.nombre,
          otros.map((c) => c.nombre),
        )
      ) {
        throw new ConflictException('Ya existe un color con ese nombre');
      }
    }
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
