import { describe, expect, it } from 'vitest';
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
} from './format';

// T0.11 — BLUEPRINT §12.3: "$ 12.500,50" (punto de miles, coma decimal),
// "dd/mm/aaaa" y "dd/mm/aaaa HH:mm" en 24 horas. Único helper de cada
// formato — nada se formatea a mano en un componente.

describe('formatCurrency', () => {
  it('formatea con punto de miles y coma decimal, prefijo "$ " (BLUEPRINT §12.3)', () => {
    expect(formatCurrency('12500.50')).toBe('$ 12.500,50');
  });

  it('acepta un string sin decimales y completa a 2', () => {
    expect(formatCurrency('100')).toBe('$ 100,00');
  });

  it('acepta un number', () => {
    expect(formatCurrency(2999)).toBe('$ 2.999,00');
  });

  it('redondea a 2 decimales si viene con más (no debería pasar desde el backend, pero no debe romper)', () => {
    expect(formatCurrency('10.999')).toBe('$ 11,00');
  });

  it('formatea 0 correctamente', () => {
    expect(formatCurrency('0')).toBe('$ 0,00');
  });

  it('formatea negativos (vuelto, ajustes) con el signo antes del símbolo', () => {
    expect(formatCurrency('-50.25')).toBe('$ -50,25');
  });
});

describe('formatDate', () => {
  it('formatea dd/mm/aaaa en hora argentina', () => {
    // 2026-08-23T12:00:00Z es mediodía UTC, bien lejos de cualquier borde
    // de medianoche en America/Argentina/Buenos_Aires (UTC-3).
    expect(formatDate('2026-08-23T12:00:00.000Z')).toBe('23/08/2026');
  });

  it('convierte a hora argentina antes de formatear: 2026-08-24T02:00:00Z todavía es 23/08 en Argentina (UTC-3)', () => {
    expect(formatDate('2026-08-24T02:00:00.000Z')).toBe('23/08/2026');
  });

  it('acepta un objeto Date directamente', () => {
    expect(formatDate(new Date('2026-01-05T12:00:00.000Z'))).toBe('05/01/2026');
  });
});

describe('formatDateTime', () => {
  it('formatea dd/mm/aaaa HH:mm en 24 horas y hora argentina', () => {
    // 23:30 UTC == 20:30 en Argentina (UTC-3), mismo día.
    expect(formatDateTime('2026-08-23T23:30:00.000Z')).toBe('23/08/2026 20:30');
  });

  it('nunca usa formato 12 horas (sin AM/PM)', () => {
    // 00:15 UTC == 21:15 del día anterior en Argentina.
    const result = formatDateTime('2026-08-23T00:15:00.000Z');
    expect(result).not.toMatch(/[ap]\.?\s?m\.?/i);
    expect(result).toBe('22/08/2026 21:15');
  });
});

describe('formatNumber', () => {
  it('separa miles con punto, sin decimales ni prefijo', () => {
    expect(formatNumber(1234)).toBe('1.234');
  });

  it('formatea números chicos sin separador', () => {
    expect(formatNumber(42)).toBe('42');
  });

  it('formatea 0', () => {
    expect(formatNumber(0)).toBe('0');
  });
});
