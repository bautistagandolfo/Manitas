// Tipos que reflejan las respuestas del backend (`sales`, T4.1-T4.11).
// Los importes viajan como string (Decimal serializado, BLUEPRINT §9.3),
// nunca number.

export type PaymentMetodo =
  | 'EFECTIVO'
  | 'TARJETA_DEBITO'
  | 'TARJETA_CREDITO'
  | 'TRANSFERENCIA'
  | 'CREDITO_DEVOLUCION';

// `Sale` tal como lo devuelve `POST /sales` — fila plana, sin
// `items`/`payments`/`discounts` anidados (esos campos no están en el
// modelo `Sale`, así que no hace falta ocultar costo para SELLER acá:
// `Sale` no tiene ningún campo de costo, RN-10 no aplica a esta
// respuesta).
export interface Sale {
  id: number;
  numero: number;
  fecha: string;
  userId: number;
  cashRegisterSessionId: number;
  subtotal: string;
  descuentoTotal: string;
  ajusteRedondeo: string;
  total: string;
  estado: string;
  idempotencyKey: string | null;
}
