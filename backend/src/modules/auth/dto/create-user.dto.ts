import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Tope defensivo: argon2 hashea igual una contraseña de 8 caracteres que
  // una de 1MB, y el login corre el hash SIEMPRE (hasta con email
  // inexistente, por diseño — ver auth.service.ts). Sin este límite, un
  // body enorme amplifica el costo de CPU de cada intento de login.
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nombre!: string;

  @IsEnum(UserRole)
  rol!: UserRole;
}
