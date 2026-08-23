import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  // Tope defensivo: ver create-user.dto.ts — validateUser() corre argon2
  // siempre, exista o no el email, así que un password gigante amplifica
  // el costo de cada intento (más relevante acá que en ningún otro lado:
  // es la ruta pública sin sesión que cualquiera puede golpear).
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  password!: string;
}
