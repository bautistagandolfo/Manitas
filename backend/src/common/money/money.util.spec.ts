import { Prisma } from '@prisma/client';
import {
  applyPercentage,
  lineSubtotal,
  prorate,
  roundCurrency,
} from './money.util';

describe('roundCurrency', () => {
  it('redondea comercial (medio hacia arriba), no bancario', () => {
    // decimal.js con ROUND_HALF_EVEN redondearía 2.005 a 2.00 (el par más
    // cercano); acá tiene que dar 2.01 — es la diferencia entre los dos
    // modos de redondeo, y BLUEPRINT §9.3 exige el comercial.
    expect(roundCurrency('2.005').toFixed(2)).toBe('2.01');
  });

  it('no introduce el error clásico de punto flotante (0.1 + 0.2)', () => {
    const result = roundCurrency(
      new Prisma.Decimal('0.1').plus(new Prisma.Decimal('0.2')),
    );
    expect(result.toFixed(2)).toBe('0.30');
  });

  it('acepta number, string y Decimal como input', () => {
    expect(roundCurrency(10).toFixed(2)).toBe('10.00');
    expect(roundCurrency('10.999').toFixed(2)).toBe('11.00');
    expect(roundCurrency(new Prisma.Decimal('5.5')).toFixed(2)).toBe('5.50');
  });
});

describe('lineSubtotal', () => {
  it('cantidad × precio unitario, redondeado a 2 decimales', () => {
    expect(lineSubtotal(3, '2.335').toFixed(2)).toBe('7.01');
  });
});

describe('applyPercentage', () => {
  // Test obligatorio #1 de BLUEPRINT §9.3: "15% sobre $2.999 con cobro de
  // $2.549" — $2.999 en formato argentino (punto de miles) es $2999; el
  // total resultante es exactamente $2549,15.
  it('BLUEPRINT §9.3, test obligatorio 1: 15% de descuento sobre $2.999 da un total de $2.549,15', () => {
    const subtotal = new Prisma.Decimal('2999.00');
    const descuento = applyPercentage(subtotal, '15');
    const total = roundCurrency(subtotal.minus(descuento));

    expect(descuento.toFixed(2)).toBe('449.85');
    expect(total.toFixed(2)).toBe('2549.15');
  });

  it('redondea el porcentaje antes de devolverlo, no lo deja para después', () => {
    // 33.33% de 10 = 3.333 → redondeado, 3.33 — no 3.333 sin redondear.
    expect(applyPercentage('10', '33.33').toFixed(2)).toBe('3.33');
  });
});

describe('prorate', () => {
  // Test obligatorio #2 de BLUEPRINT §9.3: una venta de tres líneas con
  // descuento donde el prorrateo naïve (redondear cada línea por separado,
  // sin ajustar el residuo) deja SUM(neto_linea) != total. Acá:
  // subtotal = 10.00 + 10.00 + 10.01 = 30.01; total = 27.00 (post-descuento).
  // Los netos redondeados independientemente dan 9.00 + 9.00 + 9.01 = 27.01
  // — un centavo de más. `prorate` tiene que corregirlo en la línea de
  // mayor neto (la tercera) y devolver exactamente 27.00.
  it('BLUEPRINT §9.3, test obligatorio 2: SUM(neto_linea) da exactamente el total, incluso cuando el redondeo naïve deja residuo', () => {
    const lineAmounts = ['10.00', '10.00', '10.01'];
    const total = '27.00';

    const netos = prorate(lineAmounts, total);

    const sum = netos.reduce(
      (acc, neto) => acc.plus(neto),
      new Prisma.Decimal(0),
    );
    expect(sum.toFixed(2)).toBe('27.00');
    // El residuo (-0.01) se ajusta en la línea de mayor neto (la tercera,
    // que sin ajustar redondeaba a 9.01) — no en la primera que encuentre.
    expect(netos.map((n) => n.toFixed(2))).toEqual(['9.00', '9.00', '9.00']);
  });

  it('sin residuo, cada línea queda con su proporción exacta', () => {
    const netos = prorate(['10.00', '10.00', '10.00'], '27.00');
    expect(netos.map((n) => n.toFixed(2))).toEqual(['9.00', '9.00', '9.00']);
  });

  it('desempata por menor índice cuando dos líneas empatan en el máximo', () => {
    // subtotal = 25.00 (10 + 10 + 5), total = 24.99: los netos naïve dan
    // 10.00, 10.00 y 5.00 — las dos primeras empatadas en el máximo, suma
    // 25.00 (un centavo de más). El ajuste (-0.01) tiene que caer en el
    // índice 0, no en el 1.
    const netos = prorate(['10.00', '10.00', '5.00'], '24.99');

    expect(netos.map((n) => n.toFixed(2))).toEqual(['9.99', '10.00', '5.00']);
  });

  it('rechaza prorratear sobre un subtotal de líneas en 0', () => {
    expect(() => prorate(['0.00', '0.00'], '10.00')).toThrow();
  });
});
