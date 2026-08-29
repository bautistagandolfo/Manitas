import { IsNotEmpty, IsString } from 'class-validator';

// PATCH /settings/:clave — `valor` viaja siempre como string, sin
// importar si la clave es BOOL/INT/DECIMAL (mismo criterio que
// `Expense.monto`, BLUEPRINT §9.3). El formato específico de cada tipo
// (`"true"/"false"`, entero, decimal) lo valida `SettingsService.
// setValor`, que es quien conoce el tipo real de la clave — este DTO
// solo exige que llegue algo no vacío.
export class UpdateSettingDto {
  @IsString()
  @IsNotEmpty()
  valor!: string;
}
