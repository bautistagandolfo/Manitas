import { httpClient } from '../../lib/http-client';
import type { PaymentMetodo, ReturnResult, SaleReturnInfo } from './types';

export function buscarVentaParaDevolucion(
  numero: number,
): Promise<SaleReturnInfo> {
  return httpClient.get<SaleReturnInfo>(`/returns/sales/${numero}`);
}

export interface CreateReturnItemData {
  saleItemId: number;
  cantidad: number;
  reingresaStock: boolean;
}

export interface CreateReturnPaymentData {
  metodo: PaymentMetodo;
  monto: string;
  referencia?: string;
}

export interface CreateReturnVentaNuevaData {
  items: Array<{ variantId: number; cantidad: number }>;
  payments: CreateReturnPaymentData[];
}

export interface CreateReturnData {
  saleId: number;
  tipo: 'DEVOLUCION' | 'CAMBIO';
  items: CreateReturnItemData[];
  returnPayments: CreateReturnPaymentData[];
  ventaNueva?: CreateReturnVentaNuevaData;
}

// T5.7 — RN-9/§9.7: idempotente, mismo patrón que `createSale`.
export function crearDevolucion(
  data: CreateReturnData,
  idempotencyKey: string,
): Promise<ReturnResult> {
  return httpClient.post<ReturnResult>('/returns', data, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}
