import { httpClient } from '../../lib/http-client';
import type {
  Brand,
  Category,
  Size,
  Color,
  Product,
  ProductWithVariants,
  Variant,
  VariantSearchResult,
  PaginatedResult,
} from './types';

export function getBrands(): Promise<Brand[]> {
  return httpClient.get<Brand[]>('/brands');
}

export function getCategories(): Promise<Category[]> {
  return httpClient.get<Category[]>('/categories');
}

export function getSizes(): Promise<Size[]> {
  return httpClient.get<Size[]>('/sizes');
}

export function getColors(): Promise<Color[]> {
  return httpClient.get<Color[]>('/colors');
}

// Ticket nuevo (post Release Candidate) — hallazgo real de uso: estos
// cuatro combos solo dejaban ELEGIR (GET), nunca crear, aunque los
// cuatro POST del backend ya existían sin @Roles() (cualquiera
// autenticado, como el resto del catálogo). Mismo criterio de "sin
// marca/categoría se puede seguir sin problema" no aplica acá — la
// ausencia real era de UI, no de permiso.
export function createBrand(nombre: string): Promise<Brand> {
  return httpClient.post<Brand>('/brands', { nombre });
}

export function createCategory(nombre: string): Promise<Category> {
  return httpClient.post<Category>('/categories', { nombre });
}

// `orden` (BLUEPRINT §3.2): S/M/L/XL en ese orden, no alfabético —
// único de los cuatro que lo necesita.
export function createSize(nombre: string, orden: number): Promise<Size> {
  return httpClient.post<Size>('/sizes', { nombre, orden });
}

export function createColor(nombre: string): Promise<Color> {
  return httpClient.post<Color>('/colors', { nombre });
}

export interface SearchVariantsParams {
  q?: string;
  page?: number;
  pageSize?: number;
}

// RN-11/RN-12: buscador unificado, paginado en el servidor (T2.7).
export function searchVariants(
  params: SearchVariantsParams,
): Promise<PaginatedResult<VariantSearchResult>> {
  const query = new URLSearchParams();
  if (params.q) query.set('q', params.q);
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  const qs = query.toString();
  return httpClient.get<PaginatedResult<VariantSearchResult>>(
    `/variants/search${qs ? `?${qs}` : ''}`,
  );
}

export function getProduct(id: number): Promise<ProductWithVariants> {
  return httpClient.get<ProductWithVariants>(`/products/${id}`);
}

export interface ProductFormValues {
  nombre: string;
  descripcion?: string;
  brandId?: number;
  categoryId?: number;
}

export function createProduct(data: ProductFormValues): Promise<Product> {
  return httpClient.post<Product>('/products', data);
}

export function updateProduct(
  id: number,
  data: Partial<ProductFormValues> & { activo?: boolean },
): Promise<Product> {
  return httpClient.patch<Product>(`/products/${id}`, data);
}

// Ticket nuevo (post Release Candidate): sku opcional — sin él, el
// backend genera uno (mismo criterio que la grilla, `GridFila.sku`).
export interface CreateVariantValues {
  sizeId?: number;
  colorId?: number;
  sku?: string;
  barcode?: string;
  precioVenta: string;
  costoActual: string;
}

// OWNER-only (AMB-11, RESUELTA): crear una variante fija su costo inicial.
export function createVariant(
  productId: number,
  data: CreateVariantValues,
): Promise<Variant> {
  return httpClient.post<Variant>(`/products/${productId}/variants`, data);
}

export interface GridFila {
  sizeId: number;
  colorId: number;
  sku?: string;
  stock: number;
  precioVenta: string;
  costo: string;
}

// RN-8/T2.11 — OWNER-only. sizeIds/colorIds solo se usan para el chequeo
// de completitud del backend (filas.length === sizeIds × colorIds); las
// filas ya traen los valores finales resueltos.
export function createVariantGrid(
  productId: number,
  data: { sizeIds: number[]; colorIds: number[]; filas: GridFila[] },
): Promise<Variant[]> {
  return httpClient.post<Variant[]>(
    `/products/${productId}/variants/grid`,
    data,
  );
}

export function updateVariant(
  id: number,
  data: { sku?: string; barcode?: string; activo?: boolean },
): Promise<Variant> {
  return httpClient.patch<Variant>(`/variants/${id}`, data);
}

// OWNER-only.
export function updateVariantPrice(
  id: number,
  precioVenta: string,
): Promise<Variant> {
  return httpClient.patch<Variant>(`/variants/${id}/price`, { precioVenta });
}

// OWNER-only. Sin Idempotency-Key a propósito (decisión del PO, T2.5).
export function registrarEntrada(data: {
  variantId: number;
  cantidad: number;
  costoUnitario: string;
}): Promise<Variant> {
  return httpClient.post<Variant>('/stock/entradas', data);
}

// OWNER-only.
export function registrarAjuste(data: {
  variantId: number;
  delta: number;
  motivo: string;
}): Promise<Variant> {
  return httpClient.post<Variant>('/stock/ajustes', data);
}
