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
  totalDevuelto: string;
  tipo: 'DEVOLUCION' | 'CAMBIO';
  idempotencyKey: string | null;
  autorizadoPorUserId: number | null;
}
