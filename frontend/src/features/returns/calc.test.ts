import { describe, expect, it } from 'vitest';
import {
  creditoAplicadoCents,
  diferenciaACobrarCents,
  extraAReintegrarCents,
  lineNetoADevolverCents,
  saldoReintegroCents,
  sumReintegrosCents,
  totalADevolverCents,
} from './calc';
import type { DevolucionLineSelection, DraftReintegro } from './calc';
import type { SaleReturnInfoItem } from './types';

function buildItem(
  overrides: Partial<SaleReturnInfoItem> = {},
): SaleReturnInfoItem {
  return {
    saleItemId: 1,
    variantId: 10,
    descripcionSnapshot: 'Campera - M - Negro',
    cantidadVendida: 4,
    cantidadDisponible: 4,
    netoLineaOriginal: '400.00',
    netoLineaDisponible: '400.00',
    ...overrides,
  };
}

describe('lineNetoADevolverCents', () => {
  it('cantidad 0 no devuelve nada', () => {
    expect(lineNetoADevolverCents(buildItem(), 0)).toBe(0);
  });

  it('devolver la línea completa usa netoLineaDisponible tal cual (AD-18, remanente exacto)', () => {
    const item = buildItem({
      cantidadVendida: 3,
      cantidadDisponible: 1,
      netoLineaOriginal: '299.97',
      // Remanente exacto que el backend ya calculó — no necesariamente
      // 1/3 de 299.97 (99.99), puede llevar el ajuste de redondeo
      // acumulado de las devoluciones previas.
      netoLineaDisponible: '99.99',
    });
    expect(lineNetoADevolverCents(item, 1)).toBe(9999);
  });

  it('devolución parcial: proporcional a la cantidad, redondeo comercial (ROUND_HALF_UP)', () => {
    // 100.00 de 3 unidades -> 33.33 por unidad exacto (sin redondeo).
    const item = buildItem({
      cantidadVendida: 3,
      cantidadDisponible: 3,
      netoLineaOriginal: '100.00',
      netoLineaDisponible: '100.00',
    });
    expect(lineNetoADevolverCents(item, 1)).toBe(3333);
    expect(lineNetoADevolverCents(item, 2)).toBe(6667);
  });

  it('cantidad igual a cantidadDisponible aunque no agote cantidadVendida (devolución previa ya consumió parte)', () => {
    const item = buildItem({
      cantidadVendida: 4,
      cantidadDisponible: 2,
      netoLineaOriginal: '400.00',
      netoLineaDisponible: '200.00',
    });
    expect(lineNetoADevolverCents(item, 2)).toBe(20000);
  });
});

describe('totalADevolverCents', () => {
  it('suma varias líneas seleccionadas', () => {
    const items: SaleReturnInfoItem[] = [
      buildItem({
        saleItemId: 1,
        netoLineaOriginal: '100.00',
        netoLineaDisponible: '100.00',
        cantidadVendida: 1,
        cantidadDisponible: 1,
      }),
      buildItem({
        saleItemId: 2,
        netoLineaOriginal: '200.00',
        netoLineaDisponible: '200.00',
        cantidadVendida: 1,
        cantidadDisponible: 1,
      }),
    ];
    const selections: DevolucionLineSelection[] = [
      { saleItemId: 1, cantidad: 1, reingresaStock: true },
      { saleItemId: 2, cantidad: 1, reingresaStock: true },
    ];
    expect(totalADevolverCents(items, selections)).toBe(30000);
  });

  it('sin selecciones, total 0', () => {
    expect(totalADevolverCents([buildItem()], [])).toBe(0);
  });

  it('ignora una selección que referencia una línea inexistente', () => {
    const selections: DevolucionLineSelection[] = [
      { saleItemId: 999, cantidad: 1, reingresaStock: true },
    ];
    expect(totalADevolverCents([buildItem()], selections)).toBe(0);
  });
});

describe('sumReintegrosCents / saldoReintegroCents', () => {
  it('suma varios reintegros en centavos enteros', () => {
    const reintegros: DraftReintegro[] = [
      { id: '1', metodo: 'EFECTIVO', monto: '0.10' },
      { id: '2', metodo: 'TARJETA_DEBITO', monto: '0.20' },
    ];
    expect(sumReintegrosCents(reintegros)).toBe(30);
  });

  it('saldo nunca negativo, aunque se haya cargado de más', () => {
    const reintegros: DraftReintegro[] = [
      { id: '1', metodo: 'EFECTIVO', monto: '150.00' },
    ];
    expect(saldoReintegroCents(10000, reintegros)).toBe(0);
  });

  it('saldo pendiente exacto', () => {
    const reintegros: DraftReintegro[] = [
      { id: '1', metodo: 'EFECTIVO', monto: '30.00' },
    ];
    expect(saldoReintegroCents(10000, reintegros)).toBe(7000);
  });
});

describe('creditoAplicadoCents / diferenciaACobrarCents / extraAReintegrarCents (cambio, RN-9)', () => {
  it('prenda nueva del mismo precio: crédito completo, sin diferencia ni excedente', () => {
    expect(creditoAplicadoCents(15000, 15000)).toBe(15000);
    expect(diferenciaACobrarCents(15000, 15000)).toBe(0);
    expect(extraAReintegrarCents(15000, 15000)).toBe(0);
  });

  it('prenda nueva más cara: crédito acotado a lo devuelto, resto es diferencia a cobrar', () => {
    expect(creditoAplicadoCents(15000, 20000)).toBe(15000);
    expect(diferenciaACobrarCents(15000, 20000)).toBe(5000);
    expect(extraAReintegrarCents(15000, 20000)).toBe(0);
  });

  it('prenda nueva más barata: crédito acotado a lo que cuesta la prenda nueva, resto se reintegra', () => {
    expect(creditoAplicadoCents(15000, 10000)).toBe(10000);
    expect(diferenciaACobrarCents(15000, 10000)).toBe(0);
    expect(extraAReintegrarCents(15000, 10000)).toBe(5000);
  });
});
