import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, User, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

// Todo el registro (incluye activo/createdAt/updatedAt) para la gestión
// OWNER-only de usuarios. No confundir con SafeAuthUser en auth.service.ts:
// esa es la identidad mínima que ve login/me, esta es la fila completa que
// necesita la pantalla de administración (para poder reactivar a alguien
// hay que ver que está inactivo).
export type SafeUser = Omit<User, 'passwordHash'>;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateUserDto): Promise<SafeUser> {
    const passwordHash = await argon2.hash(dto.password);

    try {
      return await this.prisma.user.create({
        data: {
          email: dto.email,
          passwordHash,
          nombre: dto.nombre,
          rol: dto.rol,
        },
        omit: { passwordHash: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Ya existe un usuario con ese email');
      }
      throw error;
    }
  }

  findAll(): Promise<SafeUser[]> {
    return this.prisma.user.findMany({
      orderBy: { id: 'asc' },
      omit: { passwordHash: true },
    });
  }

  // Última línea de defensa: sin esto, un OWNER puede dejar el sistema sin
  // nadie que lo pueda administrar. No está en el blueprint explícito, es
  // consecuencia directa de "baja lógica" + "solo OWNER gestiona usuarios"
  // (ver modulo-auth-spec.md, sección 2, regla 6).
  async update(id: number, dto: UpdateUserDto): Promise<SafeUser> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.user.findUnique({ where: { id } });
      if (!current) {
        throw new NotFoundException('Usuario no encontrado');
      }

      const wasActiveOwner = current.rol === UserRole.OWNER && current.activo;
      const staysActiveOwner =
        (dto.rol ?? current.rol) === UserRole.OWNER &&
        (dto.activo ?? current.activo);

      if (wasActiveOwner && !staysActiveOwner) {
        const otherActiveOwners = await tx.user.count({
          where: { id: { not: id }, rol: UserRole.OWNER, activo: true },
        });

        if (otherActiveOwners === 0) {
          throw new ConflictException(
            'No podés dejar el sistema sin ningún dueño activo',
          );
        }
      }

      return tx.user.update({
        where: { id },
        data: dto,
        omit: { passwordHash: true },
      });
    });
  }

  async resetPassword(id: number, password: string): Promise<SafeUser> {
    const passwordHash = await argon2.hash(password);

    try {
      return await this.prisma.user.update({
        where: { id },
        data: { passwordHash },
        omit: { passwordHash: true },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new NotFoundException('Usuario no encontrado');
      }
      throw error;
    }
  }
}
