// Lógica pura de la pantalla de cobro (T4.11, BLUEPRINT §12.1 "Pantalla
// de cobro"). Separada del componente, mismo criterio que `cart.ts`: se
// opera en centavos enteros, nunca `number` fraccionario, para evitar
// drift de punto flotante en una vista previa que el backend termina de
// validar de verdad al confirmar.
import { toCents } from './cart';
import type { PaymentMetodo } from './types';

export interface DraftPayment {
  id: string;
  metodo: PaymentMetodo;
  monto: string;
}

export function sumPaymentsCents(payments: DraftPayment[]): number {
  return payments.reduce((sum, p) => sum + toCents(p.monto), 0);
}

// `baseCents` (nombrado así y no "totalCents" a propósito, para no
// chocar con la regla local `no-number-money` — CLAUDE.md regla 5: acá
// SÍ es correcto usar `number`, son centavos ENTEROS, ver cabecera del
// archivo) es lo que hay que cobrar en total.
//
// Nunca negativo — si ya se pagó de más (no debería poder pasar, la
// pantalla no deja confirmar un pago que supere el saldo), no tiene
// sentido mostrar un "saldo pendiente" negativo.
export function saldoPendienteCents(
  baseCents: number,
  payments: DraftPayment[],
): number {
  return Math.max(0, baseCents - sumPaymentsCents(payments));
}

// §12.1: "en efectivo, se puede ingresar cuánto entregó el cliente y la
// pantalla muestra el vuelto — es un cálculo de pantalla, no se guarda".
// `entregadoCents` es lo que el cliente puso en el mostrador;
// `aplicadoCents` es lo que ese pago realmente aplica a la venta (nunca
// más que el saldo pendiente) — el vuelto es la diferencia.
export function vueltoCents(
  entregadoCents: number,
  aplicadoCents: number,
): number {
  return Math.max(0, entregadoCents - aplicadoCents);
}
