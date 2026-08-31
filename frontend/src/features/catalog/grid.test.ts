import { describe, expect, it } from 'vitest';
import { applyDefaultsToAllRows, buildGridRows } from './grid';

describe('buildGridRows', () => {
  it('genera el producto cartesiano talle × color (BLUEPRINT §12.2)', () => {
    const rows = buildGridRows([1, 2], [10, 20], {
      stock: 5,
      precioVenta: '10.00',
      costo: '5.00',
    });

    expect(rows).toHaveLength(4);
    expect(rows).toEqual([
      {
        sizeId: 1,
        colorId: 10,
        sku: '',
        stock: 5,
        precioVenta: '10.00',
        costo: '5.00',
      },
      {
        sizeId: 1,
        colorId: 20,
        sku: '',
        stock: 5,
        precioVenta: '10.00',
        costo: '5.00',
      },
      {
        sizeId: 2,
        colorId: 10,
        sku: '',
        stock: 5,
        precioVenta: '10.00',
        costo: '5.00',
      },
      {
        sizeId: 2,
        colorId: 20,
        sku: '',
        stock: 5,
        precioVenta: '10.00',
        costo: '5.00',
      },
    ]);
  });

  it('con un solo talle y un solo color, genera una sola fila', () => {
    expect(
      buildGridRows([1], [10], {
        stock: 0,
        precioVenta: '1.00',
        costo: '1.00',
      }),
    ).toHaveLength(1);
  });

  it('sin talles o sin colores, no genera ninguna fila', () => {
    expect(
      buildGridRows([], [10], { stock: 0, precioVenta: '1.00', costo: '1.00' }),
    ).toEqual([]);
    expect(
      buildGridRows([1], [], { stock: 0, precioVenta: '1.00', costo: '1.00' }),
    ).toEqual([]);
  });

  // Ticket nuevo (post Release Candidate) — hallazgo real de una ronda
  // de auto-revisión, reproducido en vivo: agregar un talle/color más
  // y volver a generar pisaba en silencio el precio/costo/SKU ya
  // cargado a mano en las filas existentes.
  describe('existingRows (conserva lo ya editado al agregar un talle/color más)', () => {
    it('conserva tal cual la fila de una combinación que ya existía', () => {
      const existentes = [
        {
          sizeId: 1,
          colorId: 10,
          sku: 'CUSTOM-SKU',
          stock: 3,
          precioVenta: '777.00',
          costo: '500.00',
        },
      ];

      const rows = buildGridRows(
        [1],
        [10, 20],
        { stock: 0, precioVenta: '1.00', costo: '1.00' },
        existentes,
      );

      expect(rows).toEqual([
        existentes[0],
        {
          sizeId: 1,
          colorId: 20,
          sku: '',
          stock: 0,
          precioVenta: '1.00',
          costo: '1.00',
        },
      ]);
    });

    it('sin existingRows (default []), genera todo desde cero — mismo comportamiento que antes de este ticket', () => {
      const rows = buildGridRows([1], [10], {
        stock: 5,
        precioVenta: '10.00',
        costo: '5.00',
      });

      expect(rows).toEqual([
        {
          sizeId: 1,
          colorId: 10,
          sku: '',
          stock: 5,
          precioVenta: '10.00',
          costo: '5.00',
        },
      ]);
    });

    it('si se deselecciona un talle/color, la fila existente de esa combinación desaparece', () => {
      const existentes = [
        {
          sizeId: 1,
          colorId: 10,
          sku: 'A',
          stock: 1,
          precioVenta: '1.00',
          costo: '1.00',
        },
        {
          sizeId: 2,
          colorId: 10,
          sku: 'B',
          stock: 2,
          precioVenta: '2.00',
          costo: '2.00',
        },
      ];

      // Solo el talle 1 sigue seleccionado — el 2 se sacó.
      const rows = buildGridRows(
        [1],
        [10],
        { stock: 0, precioVenta: '1.00', costo: '1.00' },
        existentes,
      );

      expect(rows).toEqual([existentes[0]]);
    });
  });
});

describe('applyDefaultsToAllRows', () => {
  it('sobrescribe stock/precio/costo en todas las filas sin tocar talle/color/SKU', () => {
    const rows = [
      {
        sizeId: 1,
        colorId: 10,
        sku: 'A',
        stock: 1,
        precioVenta: '1.00',
        costo: '1.00',
      },
      {
        sizeId: 2,
        colorId: 20,
        sku: 'B',
        stock: 2,
        precioVenta: '2.00',
        costo: '2.00',
      },
    ];

    const result = applyDefaultsToAllRows(rows, {
      stock: 9,
      precioVenta: '99.00',
      costo: '50.00',
    });

    expect(result).toEqual([
      {
        sizeId: 1,
        colorId: 10,
        sku: 'A',
        stock: 9,
        precioVenta: '99.00',
        costo: '50.00',
      },
      {
        sizeId: 2,
        colorId: 20,
        sku: 'B',
        stock: 9,
        precioVenta: '99.00',
        costo: '50.00',
      },
    ]);
  });

  it('no muta el array original', () => {
    const rows = [
      {
        sizeId: 1,
        colorId: 10,
        sku: 'A',
        stock: 1,
        precioVenta: '1.00',
        costo: '1.00',
      },
    ];

    applyDefaultsToAllRows(rows, {
      stock: 9,
      precioVenta: '9.00',
      costo: '9.00',
    });

    expect(rows[0].stock).toBe(1);
  });
});
