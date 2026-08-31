import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  esNombreDuplicado,
  normalizarParaComparar,
} from '../../common/text/normalize-for-comparison';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto';
import { UpdateExpenseCategoryDto } from './dto/update-expense-category.dto';

// T6.1 (RN-1, AD-7 — BLUEPRINT §3.7 literal): "comprar mercadería no es
// un gasto, su costo entra al resultado cuando se vende" (AD-7). Sin
// esta validación al crear/renombrar, el error contable más común del
// rubro queda a un clic de distancia. Coincidencia de substring,
// insensible a mayúsculas y acentos — no pretende ser una lista
// exhaustiva de sinónimos, es una defensa contra el error obvio, mismo
// criterio textual que da el propio blueprint como ejemplos.
const PATRONES_MERCADERIA = ['mercaderia', 'compra de ropa', 'proveedores'];

function aludeAMercaderia(nombre: string): boolean {
  const normalizado = normalizarParaComparar(nombre);
  return PATRONES_MERCADERIA.some((patron) => normalizado.includes(patron));
}

@Injectable()
export class ExpenseCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll(): Promise<ExpenseCategory[]> {
    return this.prisma.expenseCategory.findMany({
      orderBy: { nombre: 'asc' },
    });
  }

  async create(dto: CreateExpenseCategoryDto): Promise<ExpenseCategory> {
    if (aludeAMercaderia(dto.nombre)) {
      throw new BadRequestException(
        'Comprar mercadería no es un gasto — se registra como ingreso de stock',
      );
    }
    // Ticket nuevo (post Release Candidate) — hallazgo real: sin esto,
    // "alquiler" cuando ya existe "Alquiler" se creaba como una
    // categoría nueva y distinta, sin ningún aviso (verificado en vivo
    // con colores). El `@unique` de Postgres es case-sensitive; este
    // chequeo previo cubre mayúsculas Y acentos, antes de llegar al
    // `create` (cuyo catch de P2002 sigue como red de contención para
    // una carrera genuina, no como el camino principal).
    const existentes = await this.prisma.expenseCategory.findMany({
      select: { nombre: true },
    });
    if (
      esNombreDuplicado(
        dto.nombre,
        existentes.map((e) => e.nombre),
      )
    ) {
      throw new ConflictException(
        'Ya existe una categoría de gasto con ese nombre',
      );
    }
    try {
      return await this.prisma.expenseCategory.create({
        data: { nombre: dto.nombre },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe una categoría de gasto con ese nombre',
        );
      }
      throw error;
    }
  }

  async update(
    id: number,
    dto: UpdateExpenseCategoryDto,
  ): Promise<ExpenseCategory> {
    const existente = await this.prisma.expenseCategory.findUnique({
      where: { id },
    });
    if (!existente) {
      throw new NotFoundException('Categoría de gasto no encontrada');
    }
    // RN-1: una categoría `bloqueada` (las 6 seedeadas) no admite NINGÚN
    // cambio de `nombre` ni `activo` — sí se puede seguir usando en
    // `POST /expenses`. Chequeo ANTES del de nombre-mercadería: si ya
    // está bloqueada, no importa qué nombre se intente poner, se
    // rechaza igual — evita gastar el chequeo de texto en una categoría
    // que ya iba a rechazarse.
    if (
      existente.bloqueada &&
      (dto.nombre !== undefined || dto.activo !== undefined)
    ) {
      throw new ConflictException('Esta categoría no se puede modificar');
    }
    if (dto.nombre !== undefined && aludeAMercaderia(dto.nombre)) {
      throw new BadRequestException(
        'Comprar mercadería no es un gasto — se registra como ingreso de stock',
      );
    }
    // Ticket nuevo — mismo chequeo que `create`, para no poder renombrar
    // "Alquiler" a "servicios" cuando ya existe "Servicios". Excluye la
    // propia fila (`id`) para no chocar contra sí misma en un guardado
    // que no le cambia el nombre.
    if (dto.nombre !== undefined) {
      const otras = await this.prisma.expenseCategory.findMany({
        where: { id: { not: id } },
        select: { nombre: true },
      });
      if (
        esNombreDuplicado(
          dto.nombre,
          otras.map((e) => e.nombre),
        )
      ) {
        throw new ConflictException(
          'Ya existe una categoría de gasto con ese nombre',
        );
      }
    }
    try {
      return await this.prisma.expenseCategory.update({
        where: { id },
        data: dto,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Ya existe una categoría de gasto con ese nombre',
        );
      }
      throw error;
    }
  }
}
