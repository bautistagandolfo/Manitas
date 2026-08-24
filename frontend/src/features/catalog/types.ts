// Tipos que reflejan las respuestas del backend (products/variants/stock,
// T2.1-T2.11). Los importes viajan como string (Decimal serializado,
// BLUEPRINT §9.3) — nunca number.

export interface Brand {
  id: number;
  nombre: string;
  activo: boolean;
}

export interface Category {
  id: number;
  nombre: string;
  activo: boolean;
}

export interface Size {
  id: number;
  nombre: string;
  orden: number;
  activo: boolean;
}

export interface Color {
  id: number;
  nombre: string;
  activo: boolean;
}

export interface Product {
  id: number;
  nombre: string;
  descripcion: string | null;
  brandId: number | null;
  categoryId: number | null;
  activo: boolean;
}

// costoActual ausente si quien pregunta no es OWNER (RN-3) — nunca null,
// directamente no viaja.
export interface Variant {
  id: number;
  productId: number;
  sizeId: number | null;
  colorId: number | null;
  sku: string;
  barcode: string | null;
  precioVenta: string;
  costoActual?: string;
  stockActual: number;
  activo: boolean;
}

export interface ProductWithVariants extends Product {
  variants: Variant[];
}

export interface VariantSearchResult {
  id: number;
  sku: string;
  barcode: string | null;
  precioVenta: string;
  costoActual?: string;
  stockActual: number;
  activo: boolean;
  product: { id: number; nombre: string };
  size: { id: number; nombre: string } | null;
  color: { id: number; nombre: string } | null;
}

export interface PaginatedResult<T> {
  items: T[];
  itemCount: number;
  page: number;
  pageSize: number;
}
