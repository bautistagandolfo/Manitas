import { httpClient } from '../../lib/http-client';
import type {
  CreditoDevolucionInfo,
  PaginatedResult,
  PaymentMetodo,
  ReturnResult,
  SaleListItem,
  SaleReturnInfo,
} from './types';

export function buscarVentaParaDevolucion(
  numero: number,
): Promise<SaleReturnInfo> {
  return httpClient.get<SaleReturnInfo>(`/returns/sales/${numero}`);
}

export interface ListarVentasParams {
  desde?: string;
  hasta?: string;
  page?: number;
  pageSize?: number;
}

// Ticket nuevo (post Release Candidate) — mismo motivo que el backend
// (`GET /sales`, `sales.controller.ts`): sin ticket impreso (AMB-9
// diferida) el número de venta se pierde apenas se cierra el toast del
// cobro. Esta búsqueda por fecha, desde `DevolucionPage`, es la forma de
// recuperarlo.
export function listarVentas(
  params: ListarVentasParams = {},
): Promise<PaginatedResult<SaleListItem>> {
  const query = new URLSearchParams();
  if (params.desde) query.set('desde', params.desde);
  if (params.hasta) query.set('hasta', params.hasta);
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  const qs = query.toString();
  return httpClient.get<PaginatedResult<SaleListItem>>(
    `/sales${qs ? `?${qs}` : ''}`,
  );
}

// T5.8 — usado desde `CobroPage.tsx` (`sales`) para la quinta opción de
// medio de pago, "Aplicar crédito de devolución".
export function consultarCredito(
  numero: number,
): Promise<CreditoDevolucionInfo> {
  return httpClient.get<CreditoDevolucionInfo>(`/returns/${numero}/credito`);
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
