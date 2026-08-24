// Los 4 parámetros configurables de BLUEPRINT.md sección 10. Constantes en
// vez de strings sueltos en cada módulo que los consuma (`sales`, `returns`,
// `cash-registers`) — un typo en la clave rompe silenciosamente (404 recién
// en producción), un typo en el nombre de la constante no compila.
export const SETTINGS_KEYS = {
  PERMITIR_VENTA_SIN_STOCK: 'permitir_venta_sin_stock',
  MAX_DESCUENTO_VENDEDOR_PCT: 'max_descuento_vendedor_pct',
  DIAS_PLAZO_DEVOLUCION: 'dias_plazo_devolucion',
  UMBRAL_DIFERENCIA_CAJA: 'umbral_diferencia_caja',
} as const;

export type SettingKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];
