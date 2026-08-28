import { httpClient } from '../../lib/http-client';
import type { PaymentMetodo, Sale } from './types';

export interface CreateSaleItemData {
  variantId: number;
  cantidad: number;
}

export interface CreateSaleDiscountData {
  descripcion: string;
  porcentaje?: string;
  monto?: string;
}

export interface CreateSalePaymentData {
  metodo: PaymentMetodo;
  monto: string;
  referencia?: string;
  // T5.8 (AMB-16 diferida) — obligatorio junto con
  // `metodo: 'CREDITO_DEVOLUCION'`, ausente en cualquier otro caso. El
  // backend vuelve a validar el límite real (invariante 14); esta
  // pantalla solo arma el payload.
  returnId?: number;
}

export interface CreateSaleData {
  items: CreateSaleItemData[];
  payments: CreateSalePaymentData[];
  discounts?: CreateSaleDiscountData[];
  ajusteRedondeo?: string;
}

// T4.11 — RN-9/§9.7: idempotente, mismo patrón que
// `registrarIngreso`/`registrarRetiro` de `cash-registers` (T3.3) — la
// clave viaja por header, generada al entrar a la pantalla de venta
// (T4.10), nunca en el body.
export function createSale(
  data: CreateSaleData,
  idempotencyKey: string,
): Promise<Sale> {
  return httpClient.post<Sale>('/sales', data, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}
