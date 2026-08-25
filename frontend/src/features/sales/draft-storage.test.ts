import { describe, expect, it } from 'vitest';
import {
  clearDraft,
  loadDraft,
  saveDraft,
  type KeyValueStorage,
} from './draft-storage';
import type { CartLine } from './cart';

function buildMemoryStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

const line: CartLine = {
  variantId: 10,
  sku: 'SKU-1',
  barcode: null,
  descripcion: 'Remera',
  cantidad: 2,
  precioVenta: '100.00',
  stockActual: 5,
};

describe('loadDraft', () => {
  it('sin nada guardado, devuelve un borrador vacío', () => {
    const storage = buildMemoryStorage();
    expect(loadDraft(storage, 'venta:draft')).toEqual({
      lines: [],
      discounts: [],
    });
  });

  it('un borrador corrupto (JSON inválido) nunca tumba la pantalla — devuelve vacío', () => {
    const storage = buildMemoryStorage();
    storage.setItem('venta:draft', '{esto no es json');
    expect(loadDraft(storage, 'venta:draft')).toEqual({
      lines: [],
      discounts: [],
    });
  });

  it('un borrador con forma inesperada (lines/discounts ausentes) devuelve arrays vacíos, no undefined', () => {
    const storage = buildMemoryStorage();
    storage.setItem('venta:draft', '{}');
    expect(loadDraft(storage, 'venta:draft')).toEqual({
      lines: [],
      discounts: [],
    });
  });
});

describe('saveDraft / loadDraft', () => {
  it('lo que se guarda es exactamente lo que se recupera', () => {
    const storage = buildMemoryStorage();
    const draft = {
      lines: [line],
      discounts: [{ id: '1', descripcion: 'Promo', monto: '10.00' }],
    };

    saveDraft(storage, 'venta:draft', draft);

    expect(loadDraft(storage, 'venta:draft')).toEqual(draft);
  });

  it('claves distintas no se pisan entre sí', () => {
    const storage = buildMemoryStorage();
    saveDraft(storage, 'venta:draft', { lines: [line], discounts: [] });
    saveDraft(storage, 'otra:draft', { lines: [], discounts: [] });

    expect(loadDraft(storage, 'venta:draft').lines).toHaveLength(1);
    expect(loadDraft(storage, 'otra:draft').lines).toHaveLength(0);
  });
});

describe('clearDraft', () => {
  it('borra el borrador — una lectura posterior vuelve a dar vacío', () => {
    const storage = buildMemoryStorage();
    saveDraft(storage, 'venta:draft', { lines: [line], discounts: [] });

    clearDraft(storage, 'venta:draft');

    expect(loadDraft(storage, 'venta:draft')).toEqual({
      lines: [],
      discounts: [],
    });
  });
});
