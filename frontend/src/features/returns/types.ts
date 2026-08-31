// Tipos que reflejan las respuestas del backend (`returns`, T5.7). Los
// importes viajan como string (Decimal serializado, BLUEPRINT §9.3),
// nunca number — mismo criterio que `features/sales/types.ts`.
import type { PaymentMetodo } from '../sales/types';

export type { PaymentMetodo };

export interface SaleReturnInfoItem {
  saleItemId: number;
  variantId: number;
  descripcionSnapshot: string;
  cantidadVendida: number;
  cantidadDisponible: number;
  netoLineaOriginal: string;
  netoLineaDisponible: string;
  // Solo presente para OWNER (RN-10 de `sales`, T5.7 backend) — ausente
  // (no `null`) para SELLER.
  costoUnitario?: string;
}

// `GET /returns/sales/:numero`.
export interface SaleReturnInfo {
  saleId: number;
  numero: number;
  fecha: string;
  estado: string;
  dentroDePlazo: boolean;
  items: SaleReturnInfoItem[];
  payments: Array<{ metodo: PaymentMetodo; monto: string }>;
}

// `Return` tal como lo devuelve `POST /returns`.
export interface ReturnResult {
  id: number;
  numero: number;
  saleId: number;
  saleNuevaId: number | null;
  // Ticket nuevo (post Release Candidate) — hallazgo real de uso: sin
  // esto, el número de la venta nueva de un CAMBIO no se mostraba en
  // ningún lado (`saleNuevaId` es un id interno). `null` en una
  // DEVOLUCION simple, que nunca genera venta nueva.
  saleNuevaNumero: number | null;
  totalDevuelto: string;
  tipo: 'DEVOLUCION' | 'CAMBIO';
  idempotencyKey: string | null;
  autorizadoPorUserId: number | null;
}

// `GET /sales` (ticket nuevo, post Release Candidate) — fila de listado,
// sin costo/margen (esos campos ni existen a nivel de cabecera de venta).
export interface SaleListItem {
  id: number;
  numero: number;
  fecha: string;
  total: string;
  estado: string;
}

export interface PaginatedResult<T> {
  items: T[];
  itemCount: number;
  page: number;
  pageSize: number;
}

// `GET /returns/:numero/credito` (T5.8, AMB-16 diferida) — cuánto
// crédito le queda disponible a una devolución para aplicarse en una
// venta futura, calculado en vivo por el backend (sin saldo cacheado
// acá tampoco: se vuelve a consultar cada vez que hace falta).
export interface CreditoDevolucionInfo {
  returnId: number;
  numero: number;
  totalDevuelto: string;
  creditoConsumido: string;
  creditoDisponible: string;
  saleId: number;
}
