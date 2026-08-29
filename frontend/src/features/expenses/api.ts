import { httpClient } from '../../lib/http-client';
import type {
  Expense,
  ExpenseCategory,
  ExpenseMedioPago,
  GastoPorCategoriaItem,
  OrdenRanking,
  PaginatedResult,
  RankingProductoItem,
  ResultadosResumen,
} from './types';

// RN-1 — ABM de categorías de gasto, abierto a cualquier rol autenticado
// (la restricción real es `bloqueada`, no el rol — T6.1).
export function getExpenseCategories(): Promise<ExpenseCategory[]> {
  return httpClient.get<ExpenseCategory[]>('/expense-categories');
}

export function createExpenseCategory(
  nombre: string,
): Promise<ExpenseCategory> {
  return httpClient.post<ExpenseCategory>('/expense-categories', { nombre });
}

export interface GetExpensesParams {
  desde?: string;
  hasta?: string;
  page?: number;
  pageSize?: number;
}

// RN-2 — OWNER-only (T6.2). Paginado en el servidor (§12.4).
export function getExpenses(
  params: GetExpensesParams = {},
): Promise<PaginatedResult<Expense>> {
  const query = new URLSearchParams();
  if (params.desde) query.set('desde', params.desde);
  if (params.hasta) query.set('hasta', params.hasta);
  if (params.page) query.set('page', String(params.page));
  if (params.pageSize) query.set('pageSize', String(params.pageSize));
  const qs = query.toString();
  return httpClient.get<PaginatedResult<Expense>>(
    `/expenses${qs ? `?${qs}` : ''}`,
  );
}

export interface RegistrarGastoData {
  expenseCategoryId: number;
  descripcion: string;
  monto: string;
  medioPago: ExpenseMedioPago;
}

// RN-2, RN-7 (§9.7) — OWNER-only, idempotente (T6.2/T6.3: si es EFECTIVO,
// el backend exige sesión de caja abierta y genera el movimiento).
export function registrarGasto(
  data: RegistrarGastoData,
  idempotencyKey: string,
): Promise<Expense> {
  return httpClient.post<Expense>('/expenses', data, {
    headers: { 'Idempotency-Key': idempotencyKey },
  });
}

// RN-11 — OWNER-only, sin excepción (T6.4/T6.5).
export function getResultados(
  desde: string,
  hasta: string,
): Promise<ResultadosResumen> {
  const query = new URLSearchParams({ desde, hasta });
  return httpClient.get<ResultadosResumen>(`/resultados?${query.toString()}`);
}

export function getRankingProductos(
  desde: string,
  hasta: string,
  orden: OrdenRanking,
): Promise<RankingProductoItem[]> {
  const query = new URLSearchParams({ desde, hasta, orden });
  return httpClient.get<RankingProductoItem[]>(
    `/resultados/ranking-productos?${query.toString()}`,
  );
}

export function getGastosPorCategoria(
  desde: string,
  hasta: string,
): Promise<GastoPorCategoriaItem[]> {
  const query = new URLSearchParams({ desde, hasta });
  return httpClient.get<GastoPorCategoriaItem[]>(
    `/resultados/gastos-por-categoria?${query.toString()}`,
  );
}
