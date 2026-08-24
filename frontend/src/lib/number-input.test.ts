import { describe, expect, it } from 'vitest';
import { parseNumberInputValue } from './number-input';

describe('parseNumberInputValue', () => {
  it('devuelve el number tal cual si ya es number', () => {
    expect(parseNumberInputValue(42)).toBe(42);
  });

  it('parsea un string numérico a number (caso real de Mantine con decimalScale/prefix)', () => {
    expect(parseNumberInputValue('2000.00')).toBe(2000);
  });

  it('un string vacío da ""', () => {
    expect(parseNumberInputValue('')).toBe('');
  });

  it('un string con solo espacios da ""', () => {
    expect(parseNumberInputValue('   ')).toBe('');
  });

  it('un string no numérico da ""', () => {
    expect(parseNumberInputValue('abc')).toBe('');
  });

  it('parsea negativos', () => {
    expect(parseNumberInputValue('-15.50')).toBe(-15.5);
  });

  it('parsea 0', () => {
    expect(parseNumberInputValue('0.00')).toBe(0);
    expect(parseNumberInputValue(0)).toBe(0);
  });
});
