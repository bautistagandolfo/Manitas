// Refleja `Setting` del backend (T0.13/T6.9) — los 4 parámetros de
// BLUEPRINT §10. `valor` viaja siempre como string, sin importar el tipo
// real (mismo criterio que `Expense.monto`, BLUEPRINT §9.3).
export type SettingTipo = 'BOOL' | 'INT' | 'DECIMAL';

export interface Setting {
  clave: string;
  valor: string;
  tipo: SettingTipo;
  updatedByUserId: number | null;
  updatedAt: string;
}
