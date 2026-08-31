import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class LoginDto {
  // Ticket nuevo (post Release Candidate) — decisión explícita del
  // usuario, apartándose a propósito de BLUEPRINT §5.1 ("Login con
  // email y contraseña"): un usuario simple, sin exigir forma de
  // email, para que una vendedora no tenga que recordar/tipear
  // "@algo.com" — pendiente reflejar en el propio BLUEPRINT.md (fuera
  // del alcance de edición de esta sesión). Sigue llamándose `email`
  // en el DTO/columna (sin migración, sin tocar el resto del módulo)
  // porque nunca fue un email real — nadie le manda nada ahí, era
  // puramente un identificador de login con esa forma. El patrón
  // (`\S{2,254}`, sin espacios) sigue aceptando cualquier valor
  // email-shaped ya existente en la base — relajación pura, no
  // restricción, así que ningún usuario/test previo se rompe.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/^\S{2,254}$/, {
    message: 'Ingresá tu usuario',
  })
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
