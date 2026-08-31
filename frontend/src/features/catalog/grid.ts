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
//
// Ticket nuevo (post Release Candidate) — hallazgo real de una ronda de
// auto-revisión, reproducido en vivo: sin `existingRows`, agregar un
// talle o color más después de ya haber completado precio/costo/SKU a
// mano en las filas existentes, y volver a apretar "Generar grilla",
// pisaba TODAS las filas con los defaults — perdía en silencio el
// trabajo ya cargado, sin ningún aviso. Ahora, la combinación
// talle×color que ya existía en `existingRows` se conserva tal cual
// (con lo que se haya editado a mano); solo las combinaciones nuevas
// arrancan con los defaults. Parámetro opcional con default `[]`: el
// primer "Generar grilla" de una pantalla nueva sigue generando todo
// desde cero, igual que siempre.
export function buildGridRows(
  sizeIds: number[],
  colorIds: number[],
  defaults: GridDefaults,
  existingRows: GridRow[] = [],
): GridRow[] {
  const existingByKey = new Map(
    existingRows.map((row) => [`${row.sizeId}-${row.colorId}`, row]),
  );
  const rows: GridRow[] = [];
  for (const sizeId of sizeIds) {
    for (const colorId of colorIds) {
      const existing = existingByKey.get(`${sizeId}-${colorId}`);
      rows.push(
        existing ?? {
          sizeId,
          colorId,
          sku: '',
          stock: defaults.stock,
          precioVenta: defaults.precioVenta,
          costo: defaults.costo,
        },
      );
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
