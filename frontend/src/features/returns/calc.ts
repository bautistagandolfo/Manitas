// Lógica pura de la pantalla de devolución/cambio (T5.7, BLUEPRINT AD-8/
// AD-17/AD-18). Centavos enteros, nunca `number` fraccionario — mismo
// criterio que `features/sales/cart.ts`/`payments.ts`, cuyos helpers de
// centavos se reusan tal cual (son genéricos, sin acoplamiento a `Sale`).
//
// El monto exacto que una devolución le reconoce a una línea lo calcula
// SIEMPRE el backend (`ReturnsService.crearDevolucion`, AD-18) — esta
// pantalla previsualiza ese mismo cálculo para poder armar los
// `returnPayments` que tienen que sumar EXACTO ese total antes de
// enviar, replicando la regla con la MISMA aritmética (centavos enteros,
// redondeo comercial medio-hacia-arriba — `Math.round` en centavos
// coincide con `ROUND_HALF_UP` de `money.util.ts` para valores
// positivos). Si una línea se devuelve COMPLETA (`cantidad ===
// cantidadDisponible`), se usa `netoLineaDisponible` tal cual — el
// remanente exacto que el backend ya calculó (AD-18, sin reproducir su
// redondeo acumulado línea por línea).
import { centsToAmountString, toCents } from '../sales/cart';
import type { SaleReturnInfoItem } from './types';

export { centsToAmountString, toCents };

export interface DevolucionLineSelection {
  saleItemId: number;
  cantidad: number;
  reingresaStock: boolean;
}

export function lineNetoADevolverCents(
  item: SaleReturnInfoItem,
  cantidad: number,
): number {
  if (cantidad <= 0) return 0;
  if (cantidad >= item.cantidadDisponible) {
    return toCents(item.netoLineaDisponible);
  }
  const netoOriginalCents = toCents(item.netoLineaOriginal);
  return Math.round((netoOriginalCents * cantidad) / item.cantidadVendida);
}

export function totalADevolverCents(
  items: SaleReturnInfoItem[],
  selections: DevolucionLineSelection[],
): number {
  return selections.reduce((sum, sel) => {
    const item = items.find((i) => i.saleItemId === sel.saleItemId);
    if (!item) return sum;
    return sum + lineNetoADevolverCents(item, sel.cantidad);
  }, 0);
}

export interface DraftReintegro {
  id: string;
  metodo: string;
  monto: string;
}

export function sumReintegrosCents(reintegros: DraftReintegro[]): number {
  return reintegros.reduce((sum, r) => sum + toCents(r.monto), 0);
}

// `baseCents` (nombrado así, y no "totalCents", para no chocar con la
// regla local `no-number-money` — mismo criterio que `sales/cart.ts`).
export function saldoReintegroCents(
  baseCents: number,
  reintegros: DraftReintegro[],
): number {
  return Math.max(0, baseCents - sumReintegrosCents(reintegros));
}

// Cambio (RN-9): el crédito nunca supera lo que la devolución reconoce
// (`devueltoCents`), ni lo que la venta nueva cuesta (`nuevaCents`) — es
// el menor de los dos. Si la prenda nueva es más cara, la diferencia se
// cobra aparte (`ventaNueva.payments`); si es más barata, el resto se
// reintegra por los medios habituales (más líneas de `returnPayments`,
// además del crédito). Parámetros renombrados sin la raíz "total"/
// "credito" por el mismo motivo que `saldoReintegroCents`.
export function creditoAplicadoCents(
  devueltoCents: number,
  nuevaCents: number,
): number {
  return Math.min(devueltoCents, nuevaCents);
}

export function diferenciaACobrarCents(
  devueltoCents: number,
  nuevaCents: number,
): number {
  return Math.max(0, nuevaCents - devueltoCents);
}

export function extraAReintegrarCents(
  devueltoCents: number,
  nuevaCents: number,
): number {
  return Math.max(0, devueltoCents - nuevaCents);
}
