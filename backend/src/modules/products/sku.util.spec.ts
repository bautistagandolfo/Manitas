import { generateSku } from './sku.util';

describe('generateSku', () => {
  it('combina productId, talle y color en mayúsculas', () => {
    expect(generateSku(42, { nombre: 'M' }, { nombre: 'Negro' })).toBe(
      'P42-M-NEGRO',
    );
  });

  it('sin talle, omite ese segmento', () => {
    expect(generateSku(7, undefined, { nombre: 'Rojo' })).toBe('P7-ROJO');
  });

  it('sin color, omite ese segmento', () => {
    expect(generateSku(7, { nombre: 'L' }, undefined)).toBe('P7-L');
  });

  it('sin talle ni color, devuelve solo el prefijo del producto', () => {
    expect(generateSku(7, undefined, undefined)).toBe('P7');
  });

  it('quita acentos y caracteres no alfanuméricos', () => {
    expect(generateSku(1, { nombre: 'Único' }, { nombre: 'Azul Marino' })).toBe(
      'P1-UNICO-AZULMARINO',
    );
  });
});
