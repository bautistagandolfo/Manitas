// Tipos que reflejan las respuestas del backend (expenses/resultados,
// T6.1-T6.6). Los importes viajan como string (Decimal serializado,
// BLUEPRINT §9.3) — nunca number.

export type ExpenseMedioPago = 'EFECTIVO' | 'TRANSFERENCIA' | 'OTRO';

export interface ExpenseCategory {
  id: number;
  nombre: string;
  activo: boolean;
  bloqueada: boolean;
}

export interface Expense {
  id: number;
  fecha: string;
  expenseCategoryId: number;
  descripcion: string;
  monto: string;
  medioPago: ExpenseMedioPago;
  userId: number;
}

export interface PaginatedResult<T> {
  items: T[];
  itemCount: number;
  page: number;
  pageSize: number;
}

// GET /resultados — T6.4/T6.5. Todos los importes como string.
export interface ResultadosResumen {
  ingresos: string;
  cmv: string;
  margenBruto: string;
  margenBrutoPct: string;
  gastos: string;
  resultadoNeto: string;
  calculadoEn: string;
  periodo: { desde: string; hasta: string };
}

export type OrdenRanking = 'unidades' | 'margen';

export interface RankingProductoItem {
  variantId: number;
  descripcionSnapshot: string;
  unidadesVendidas: number;
  margenTotal: string;
}

export interface GastoPorCategoriaItem {
  expenseCategoryId: number;
  nombre: string;
  total: string;
}
