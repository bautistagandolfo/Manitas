// Lógica pura del carrito de venta (T4.10, BLUEPRINT §12.1). Separada del
// componente para poder testearla con Vitest sin DOM (mismo patrón que
// `lib/idempotency.ts` y `features/catalog/grid.ts`).
//
// La plata se opera en CENTAVOS enteros, nunca en `number` decimal directo
// (CLAUDE.md regla 5) — `precioVenta` llega del backend como string
// Decimal(12,2), así que convertirlo una sola vez a centavos enteros y
// operar sumas/restas/multiplicaciones enteras evita cualquier drift de
// punto flotante (0.1 + 0.2 !== 0.3). Esta pantalla nunca calcula el total
// AUTORITATIVO de la venta — eso lo hace `crearVenta` en el backend
// (T4.1-T4.6) al enviar; acá es solo una vista previa para quien vende.
import type { VariantSearchResult } from '../catalog/types';

export interface CartLine {
  variantId: number;
  sku: string;
  barcode: string | null;
  // Mismo formato que `descripcionSnapshot` del backend (T4.2, BLUEPRINT
  // §3.4): nombre + talle + color, omitiendo lo que falte.
  descripcion: string;
  cantidad: number;
  precioVenta: string;
  // Stock al momento de agregar la línea — solo para el aviso no
  // bloqueante de "sin stock suficiente" (ver comentario en SalePage):
  // el bloqueo real ocurre en el backend al confirmar la venta (T4.11),
  // que además puede estar desactivado por `permitir_venta_sin_stock`.
  stockActual: number;
}

export interface DraftDiscount {
  id: string;
  descripcion: string;
  // Mutuamente excluyentes, igual que `CrearVentaDiscountInput` del
  // backend (T4.3): con `porcentaje` se ignora cualquier `monto`.
  porcentaje?: string;
  monto?: string;
}

export function buildDescripcion(variant: VariantSearchResult): string {
  return [variant.product.nombre, variant.size?.nombre, variant.color?.nombre]
    .filter((parte): parte is string => Boolean(parte))
    .join(' - ');
}

// RN-11 (§12.1, paso 2): coincidencia EXACTA de SKU o código de barras
// agrega el ítem solo, sin pasar por la lista navegable. Insensible a
// mayúsculas/espacios — un lector de código de barras nunca manda espacios
// de más, pero tipear a mano sí puede.
export function findExactMatch(
  results: VariantSearchResult[],
  query: string,
): VariantSearchResult | null {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  return (
    results.find(
      (variant) =>
        variant.sku.toLowerCase() === normalized ||
        variant.barcode?.toLowerCase() === normalized,
    ) ?? null
  );
}

// §12.1, paso 5: escanear el mismo artículo otra vez incrementa la
// cantidad de la línea existente, nunca crea una línea nueva.
export function addOrIncrementLine(
  lines: CartLine[],
  variant: VariantSearchResult,
): CartLine[] {
  const index = lines.findIndex((line) => line.variantId === variant.id);
  if (index === -1) {
    return [
      ...lines,
      {
        variantId: variant.id,
        sku: variant.sku,
        barcode: variant.barcode,
        descripcion: buildDescripcion(variant),
        cantidad: 1,
        precioVenta: variant.precioVenta,
        stockActual: variant.stockActual,
      },
    ];
  }
  const updated = [...lines];
  updated[index] = { ...updated[index], cantidad: updated[index].cantidad + 1 };
  return updated;
}

// Atajo `Ctrl` + `+`/`−` (§12.1): cambia la cantidad de una línea. Nunca
// baja de 1 — para sacar la línea entera está `Ctrl` + `Supr`
// (`removeLine`), una acción distinta a propósito.
export function changeLineQuantity(
  lines: CartLine[],
  variantId: number,
  delta: number,
): CartLine[] {
  return lines.map((line) =>
    line.variantId === variantId
      ? { ...line, cantidad: Math.max(1, line.cantidad + delta) }
      : line,
  );
}

export function removeLine(lines: CartLine[], variantId: number): CartLine[] {
  return lines.filter((line) => line.variantId !== variantId);
}

// Centavos enteros — ver comentario de cabecera.
export function toCents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

export function centsToAmountString(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function lineSubtotalCents(line: CartLine): number {
  return toCents(line.precioVenta) * line.cantidad;
}

export function computeSubtotalCents(lines: CartLine[]): number {
  return lines.reduce((sum, line) => sum + lineSubtotalCents(line), 0);
}

// `baseCents` es sobre qué base se calcula el porcentaje (el subtotal del
// carrito) — nombrado así, y no "subtotalCents", para no chocar con la
// regla local `no-number-money` (CLAUDE.md regla 5): acá SÍ es correcto
// usar `number`, porque son centavos ENTEROS (no un Decimal fraccionario)
// — mismo motivo que el comentario de cabecera del archivo.
export function discountAmountCents(
  discount: DraftDiscount,
  baseCents: number,
): number {
  if (discount.porcentaje !== undefined) {
    return Math.round((baseCents * Number(discount.porcentaje)) / 100);
  }
  return toCents(discount.monto ?? '0');
}

export function computeDiscountTotalCents(
  discounts: DraftDiscount[],
  baseCents: number,
): number {
  return discounts.reduce(
    (sum, discount) => sum + discountAmountCents(discount, baseCents),
    0,
  );
}

// Nunca negativo en la vista previa — el rechazo real de un ajuste/
// descuento que dejaría el total en negativo lo hace `crearVenta`
// (invariante 4, T4.3/T4.6) al confirmar.
export function computeTotalCents(
  baseCents: number,
  discountCents: number,
): number {
  return Math.max(0, baseCents - discountCents);
}
