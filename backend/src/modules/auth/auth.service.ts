import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';

export interface JwtPayload {
  sub: number;
  rol: UserRole;
}

export interface SafeAuthUser {
  id: number;
  email: string;
  nombre: string;
  rol: UserRole;
}

// Hash válido pero de una contraseña que nadie tiene: se usa para que
// validateUser() tarde lo mismo exista o no el email. argon2.verify es
// lento a propósito; saltearlo cuando el usuario no existe sería más
// rápido y filtraría por temporización qué emails están registrados —
// justo lo que el mensaje de error genérico (módulo spec, sección 4)
// intenta evitar.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$AiuVCeMPPdPlyNAc4Hx2hw$hG5R78wklI35FuNtcfjD/icm8J3x5hPFAoW3jtoovkw';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });

    const passwordMatches = await argon2.verify(
      user?.passwordHash ?? DUMMY_HASH,
      password,
    );

    if (!user || !user.activo || !passwordMatches) {
      return null;
    }

    return user;
  }

  issueToken(user: User): { token: string; user: SafeAuthUser } {
    const payload: JwtPayload = { sub: user.id, rol: user.rol };

    return {
      token: this.jwtService.sign(payload),
      user: {
        id: user.id,
        email: user.email,
        nombre: user.nombre,
        rol: user.rol,
      },
    };
  }
}
