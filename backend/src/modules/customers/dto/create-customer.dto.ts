import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

// Ticket nuevo (post Release Candidate) — el DNI es el dato que distingue
// de forma inequívoca (puede haber dos "Carlos Martínez", pedido
// explícito del usuario). Se normaliza ANTES de validar: saca puntos y
// espacios ("30.123.456" → "30123456") para que buscar/cargar con o sin
// puntuación encuentre lo mismo — la unicidad real vive en la columna
// (`@unique` en el schema), esto solo evita que dos formas de escribir
// el mismo DNI parezcan valores distintos.
function normalizarDni(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/[.\s-]/g, '') : value;
}

export class CreateCustomerDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  nombre!: string;

  @Transform(({ value }: { value: unknown }) => normalizarDni(value))
  @IsString()
  @Matches(/^\d{6,8}$/, {
    message: 'El DNI tiene que tener entre 6 y 8 dígitos',
  })
  dni!: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  telefono?: string;
}
