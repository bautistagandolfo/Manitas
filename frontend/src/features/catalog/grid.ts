export interface GridRow {
  sizeId: number;
  colorId: number;
  sku: string;
  stock: number;
  precioVenta: string;
  costo: string;
}

export interface GridDefaults {
  stock: number;
  precioVenta: string;
  costo: string;
}

// BLUEPRINT §12.2, punto 3: "el sistema genera las 12 combinaciones" —
// producto cartesiano talle × color, en el mismo orden que se eligieron
// los talles (fila) y colores (columna implícita). SKU vacío: se completa
// en la grilla o lo autogenera el backend si se manda vacío (T2.11).
export function buildGridRows(
  sizeIds: number[],
  colorIds: number[],
  defaults: GridDefaults,
): GridRow[] {
  const rows: GridRow[] = [];
  for (const sizeId of sizeIds) {
    for (const colorId of colorIds) {
      rows.push({
        sizeId,
        colorId,
        sku: '',
        stock: defaults.stock,
        precioVenta: defaults.precioVenta,
        costo: defaults.costo,
      });
    }
  }
  return rows;
}

// BLUEPRINT §12.2, punto 4: "aplicar el mismo precio y costo a todas de
// una vez" — sobrescribe stock/precio/costo en todas las filas sin tocar
// el talle/color/SKU de cada una.
export function applyDefaultsToAllRows(
  rows: GridRow[],
  defaults: GridDefaults,
): GridRow[] {
  return rows.map((row) => ({
    ...row,
    stock: defaults.stock,
    precioVenta: defaults.precioVenta,
    costo: defaults.costo,
  }));
}
