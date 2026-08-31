import {
  IsEnum,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
  // Ticket nuevo (post Release Candidate) — mismo criterio que
  // `login.dto.ts`: usuario simple, sin exigir forma de email (decisión
  // explícita del usuario, aparte de BLUEPRINT §5.1). Relajación pura
  // sobre lo que había antes (`@IsEmail()`) — cualquier valor
  // email-shaped que ya exista sigue siendo válido.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^\S{2,254}$/, {
    message: 'El usuario tiene que tener entre 2 y 254 caracteres, sin espacios',
  })
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
