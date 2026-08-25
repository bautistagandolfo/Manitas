// Persistencia del borrador de venta en `sessionStorage` (BLUEPRINT §12.1,
// caso "Refresco accidental del navegador": el borrador se conserva junto
// con su clave de idempotencia — perder diez ítems cargados por un F5 es
// de las cosas que hacen abandonar un sistema). Funciones puras separadas
// del componente, mismo patrón que `lib/idempotency.ts` (T3.7): así se
// testean con Vitest sin DOM.
import type { CartLine, DraftDiscount } from './cart';

// Claves compartidas entre `SalePage` (T4.10, arma el borrador) y
// `CobroPage` (T4.11, lo lee y confirma) — un solo lugar para no
// desincronizar el nombre de la clave entre las dos pantallas.
export const DRAFT_STORAGE_KEY = 'venta:draft';
export const IDEMPOTENCY_STORAGE_KEY = 'venta:idempotency-key';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SaleDraft {
  lines: CartLine[];
  discounts: DraftDiscount[];
}

const EMPTY_DRAFT: SaleDraft = { lines: [], discounts: [] };

// Un borrador corrupto o de una versión vieja del schema nunca debe
// tumbar la pantalla — se descarta en silencio y arranca vacía, mismo
// criterio de robustez que el resto del sistema tiene para datos que
// vienen de afuera de su propio control.
export function loadDraft(storage: KeyValueStorage, key: string): SaleDraft {
  const raw = storage.getItem(key);
  if (!raw) return EMPTY_DRAFT;
  try {
    const parsed = JSON.parse(raw) as Partial<SaleDraft>;
    return {
      lines: Array.isArray(parsed.lines) ? parsed.lines : [],
      discounts: Array.isArray(parsed.discounts) ? parsed.discounts : [],
    };
  } catch {
    return EMPTY_DRAFT;
  }
}

export function saveDraft(
  storage: KeyValueStorage,
  key: string,
  draft: SaleDraft,
): void {
  storage.setItem(key, JSON.stringify(draft));
}

export function clearDraft(storage: KeyValueStorage, key: string): void {
  storage.removeItem(key);
}
