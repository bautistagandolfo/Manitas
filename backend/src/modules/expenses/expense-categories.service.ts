import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseCategory, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
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

// Saca acentos sin depender de un rango de regex con caracteres
// combinantes literales en el código fuente (frágil entre editores/
// encodings) — tras `normalize('NFD')` cada letra acentuada se
// descompone en [letra base, marca diacrítica]; filtramos por código
// de punto Unicode (0x0300–0x036F = "Combining Diacritical Marks") en
// vez de un regex con esos caracteres pegados en el archivo.
const PRIMER_DIACRITICO_COMBINANTE = 0x0300;
const ULTIMO_DIACRITICO_COMBINANTE = 0x036f;

function normalizar(texto: string): string {
  return Array.from(texto.toLowerCase().normalize('NFD'))
    .filter((caracter) => {
      const codigo = caracter.codePointAt(0)!;
      return (
        codigo < PRIMER_DIACRITICO_COMBINANTE ||
        codigo > ULTIMO_DIACRITICO_COMBINANTE
      );
    })
    .join('');
}

function aludeAMercaderia(nombre: string): boolean {
  const normalizado = normalizar(nombre);
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
