import { describe, expect, it } from 'vitest';
import {
  addOrIncrementLine,
  buildDescripcion,
  centsToAmountString,
  changeLineQuantity,
  computeDiscountTotalCents,
  computeSubtotalCents,
  computeTotalCents,
  findExactMatch,
  removeLine,
  toCents,
  type CartLine,
  type DraftDiscount,
} from './cart';
import type { VariantSearchResult } from '../catalog/types';

function buildVariant(
  overrides: Partial<VariantSearchResult> = {},
): VariantSearchResult {
  return {
    id: 10,
    sku: 'SKU-1',
    barcode: 'BARCODE-1',
    precioVenta: '100.00',
    stockActual: 5,
    activo: true,
    product: { id: 1, nombre: 'Remera' },
    size: { id: 2, nombre: 'M' },
    color: { id: 3, nombre: 'Azul' },
    ...overrides,
  };
}

describe('buildDescripcion', () => {
  it('junta nombre, talle y color con " - "', () => {
    expect(buildDescripcion(buildVariant())).toBe('Remera - M - Azul');
  });

  it('omite talle/color ausentes, sin dejar "null"/"undefined" en el texto', () => {
    expect(buildDescripcion(buildVariant({ size: null, color: null }))).toBe(
      'Remera',
    );
  });
});

describe('findExactMatch', () => {
  it('encuentra por SKU exacto, insensible a mayúsculas', () => {
    const results = [buildVariant({ sku: 'ABC-123' })];
    expect(findExactMatch(results, 'abc-123')).toEqual(results[0]);
  });

  it('encuentra por código de barras exacto', () => {
    const results = [buildVariant({ barcode: '7791234567890' })];
    expect(findExactMatch(results, '7791234567890')).toEqual(results[0]);
  });

  it('una coincidencia parcial (búsqueda por texto) no cuenta como exacta', () => {
    const results = [buildVariant({ sku: 'ABC-123' })];
    expect(findExactMatch(results, 'ABC')).toBeNull();
  });

  it('query vacío nunca "matchea" nada', () => {
    const results = [buildVariant({ sku: '' })];
    expect(findExactMatch(results, '   ')).toBeNull();
  });
});

describe('addOrIncrementLine', () => {
  it('agrega una línea nueva para una variante que no estaba en el carrito', () => {
    const result = addOrIncrementLine([], buildVariant());
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      variantId: 10,
      cantidad: 1,
      descripcion: 'Remera - M - Azul',
    });
  });

  it('escanear la misma variante otra vez incrementa la cantidad, no crea una línea nueva (§12.1 paso 5)', () => {
    const first = addOrIncrementLine([], buildVariant());
    const second = addOrIncrementLine(first, buildVariant());
    expect(second).toHaveLength(1);
    expect(second[0].cantidad).toBe(2);
  });

  it('dos variantes distintas generan dos líneas separadas', () => {
    const result = addOrIncrementLine(
      addOrIncrementLine([], buildVariant({ id: 10 })),
      buildVariant({ id: 20 }),
    );
    expect(result).toHaveLength(2);
  });
});

describe('changeLineQuantity', () => {
  const line: CartLine = {
    variantId: 10,
    sku: 'SKU-1',
    barcode: null,
    descripcion: 'Remera',
    cantidad: 3,
    precioVenta: '100.00',
    stockActual: 5,
  };

  it('Ctrl + suma la cantidad', () => {
    expect(changeLineQuantity([line], 10, 1)[0].cantidad).toBe(4);
  });

  it('Ctrl - resta la cantidad', () => {
    expect(changeLineQuantity([line], 10, -1)[0].cantidad).toBe(2);
  });

  it('nunca baja de 1 — para sacar la línea entera está Ctrl+Supr, no restar hasta 0', () => {
    expect(
      changeLineQuantity([{ ...line, cantidad: 1 }], 10, -1)[0].cantidad,
    ).toBe(1);
  });

  it('no toca ninguna línea que no sea la indicada', () => {
    const other: CartLine = { ...line, variantId: 20, cantidad: 7 };
    const result = changeLineQuantity([line, other], 10, 1);
    expect(result.find((l) => l.variantId === 20)?.cantidad).toBe(7);
  });
});

describe('removeLine', () => {
  it('saca la línea indicada, deja las demás intactas', () => {
    const lines: CartLine[] = [
      {
        variantId: 10,
        sku: 'A',
        barcode: null,
        descripcion: 'A',
        cantidad: 1,
        precioVenta: '10.00',
        stockActual: 5,
      },
      {
        variantId: 20,
        sku: 'B',
        barcode: null,
        descripcion: 'B',
        cantidad: 1,
        precioVenta: '20.00',
        stockActual: 5,
      },
    ];
    const result = removeLine(lines, 10);
    expect(result).toHaveLength(1);
    expect(result[0].variantId).toBe(20);
  });
});

describe('centavos — sin drift de punto flotante', () => {
  it('toCents convierte un Decimal string a centavos enteros exactos', () => {
    expect(toCents('100.30')).toBe(10030);
    expect(toCents('0.10')).toBe(10);
  });

  it('centsToAmountString es la inversa de toCents', () => {
    expect(centsToAmountString(10030)).toBe('100.30');
  });

  it('el caso clásico de drift (0.1 + 0.2) nunca ocurre al sumar líneas en centavos', () => {
    const lines: CartLine[] = [
      {
        variantId: 1,
        sku: 'A',
        barcode: null,
        descripcion: 'A',
        cantidad: 1,
        precioVenta: '0.10',
        stockActual: 5,
      },
      {
        variantId: 2,
        sku: 'B',
        barcode: null,
        descripcion: 'B',
        cantidad: 1,
        precioVenta: '0.20',
        stockActual: 5,
      },
    ];
    expect(computeSubtotalCents(lines)).toBe(30);
  });
});

describe('computeSubtotalCents', () => {
  it('multiplica precio x cantidad por línea y suma todas', () => {
    const lines: CartLine[] = [
      {
        variantId: 1,
        sku: 'A',
        barcode: null,
        descripcion: 'A',
        cantidad: 2,
        precioVenta: '50.00',
        stockActual: 5,
      },
      {
        variantId: 2,
        sku: 'B',
        barcode: null,
        descripcion: 'B',
        cantidad: 1,
        precioVenta: '25.50',
        stockActual: 5,
      },
    ];
    expect(computeSubtotalCents(lines)).toBe(12550);
  });
});

describe('computeDiscountTotalCents', () => {
  it('un descuento por monto fijo se aplica tal cual', () => {
    const discounts: DraftDiscount[] = [
      { id: '1', descripcion: 'Promo', monto: '15.00' },
    ];
    expect(computeDiscountTotalCents(discounts, 10000)).toBe(1500);
  });

  it('un descuento por porcentaje se calcula sobre el subtotal', () => {
    const discounts: DraftDiscount[] = [
      { id: '1', descripcion: '15%', porcentaje: '15' },
    ];
    // Mismo caso obligatorio de BLUEPRINT §9.3: 15% de $2999 = $449.85.
    expect(computeDiscountTotalCents(discounts, 299900)).toBe(44985);
  });

  it('varios descuentos se suman', () => {
    const discounts: DraftDiscount[] = [
      { id: '1', descripcion: 'A', monto: '10.00' },
      { id: '2', descripcion: 'B', porcentaje: '10' },
    ];
    expect(computeDiscountTotalCents(discounts, 10000)).toBe(1000 + 1000);
  });
});

describe('computeTotalCents', () => {
  it('subtotal menos descuento', () => {
    expect(computeTotalCents(10000, 1500)).toBe(8500);
  });

  it('nunca queda negativo en la vista previa, aunque el descuento supere el subtotal', () => {
    expect(computeTotalCents(1000, 5000)).toBe(0);
  });
});
