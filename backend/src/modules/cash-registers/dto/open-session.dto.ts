import { IsDecimal } from 'class-validator';

export class OpenSessionDto {
  // String, no number — mismo motivo que costoUnitario en
  // create-entrada.dto.ts: un JSON number ya pasó por el redondeo de punto
  // flotante de JSON.parse antes de llegar acá (BLUEPRINT §9.3). Puede ser
  // 0 (turno sin cambio, caso borde válido de la spec) — la validación de
  // "no negativo" vive en CashRegisterService.abrirSesion, no acá.
  @IsDecimal({ decimal_digits: '0,2', force_decimal: false })
  montoInicial!: string;
}
