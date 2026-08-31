import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { normalizarDni } from './create-customer.dto';

// Ticket nuevo (post Release Candidate) — pedido directo del usuario:
// "editar o dar de baja, por si pusimos mal datos". Mismo patrón que
// `UpdateBrandDto` (todos los campos opcionales, PATCH parcial) — la
// unicidad de DNI y el formato se validan igual que en el alta.
export class UpdateCustomerDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(200)
  nombre?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => normalizarDni(value))
  @IsString()
  @Matches(/^\d{6,8}$/, {
    message: 'El DNI tiene que tener entre 6 y 8 dígitos',
  })
  dni?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(50)
  telefono?: string;

  @IsOptional()
  @IsBoolean()
  activo?: boolean;
}
