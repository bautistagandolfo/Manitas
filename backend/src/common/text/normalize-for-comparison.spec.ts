import {
  esNombreDuplicado,
  normalizarParaComparar,
} from './normalize-for-comparison';

describe('normalizarParaComparar', () => {
  it('ignora mayúsculas/minúsculas — el caso real que motivó esto ("Negro" vs "negro")', () => {
    expect(normalizarParaComparar('Negro')).toBe(
      normalizarParaComparar('negro'),
    );
    expect(normalizarParaComparar('NEGRO')).toBe(
      normalizarParaComparar('negro'),
    );
  });

  it('ignora acentos — nombres típicos del rubro ("Bordó", "Café", "Marrón")', () => {
    expect(normalizarParaComparar('Bordó')).toBe(
      normalizarParaComparar('Bordo'),
    );
    expect(normalizarParaComparar('Café')).toBe(normalizarParaComparar('cafe'));
    expect(normalizarParaComparar('Marrón')).toBe(
      normalizarParaComparar('MARRON'),
    );
  });

  it('ignora espacios al principio/final, pero no los del medio', () => {
    expect(normalizarParaComparar('  Rosa  ')).toBe(
      normalizarParaComparar('Rosa'),
    );
    expect(normalizarParaComparar('Verde oliva')).not.toBe(
      normalizarParaComparar('Verdeoliva'),
    );
  });

  it('nombres genuinamente distintos siguen distintos', () => {
    expect(normalizarParaComparar('Negro')).not.toBe(
      normalizarParaComparar('Blanco'),
    );
  });
});

describe('esNombreDuplicado', () => {
  it('el caso real verificado en vivo: "negro" duplica "Negro" ya existente', () => {
    expect(esNombreDuplicado('negro', ['Negro', 'Blanco'])).toBe(true);
  });

  it('duplica por acento también ("Bordo" vs "Bordó")', () => {
    expect(esNombreDuplicado('Bordo', ['Bordó'])).toBe(true);
  });

  it('un nombre genuinamente nuevo no duplica nada', () => {
    expect(esNombreDuplicado('Verde', ['Negro', 'Blanco'])).toBe(false);
  });

  it('lista vacía nunca duplica', () => {
    expect(esNombreDuplicado('Negro', [])).toBe(false);
  });
});
