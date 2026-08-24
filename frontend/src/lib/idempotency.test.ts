import { describe, expect, it } from 'vitest';
import {
  getOrCreateIdempotencyKey,
  rotateIdempotencyKey,
  type KeyValueStorage,
} from './idempotency';

function buildMemoryStorage(): KeyValueStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
}

describe('getOrCreateIdempotencyKey', () => {
  it('crea una clave nueva si no hay ninguna guardada, y la persiste', () => {
    const storage = buildMemoryStorage();

    const key = getOrCreateIdempotencyKey(storage, 'test-key');

    expect(key).toBeTruthy();
    expect(storage.getItem('test-key')).toBe(key);
  });

  it('reusa la clave existente en vez de generar una nueva (BLUEPRINT §9.7/§12.1: sobrevive a un F5)', () => {
    const storage = buildMemoryStorage();
    const first = getOrCreateIdempotencyKey(storage, 'test-key');

    const second = getOrCreateIdempotencyKey(storage, 'test-key');

    expect(second).toBe(first);
  });

  it('claves distintas no se pisan entre sí', () => {
    const storage = buildMemoryStorage();

    const a = getOrCreateIdempotencyKey(storage, 'accion-a');
    const b = getOrCreateIdempotencyKey(storage, 'accion-b');

    expect(a).not.toBe(b);
  });
});

describe('rotateIdempotencyKey', () => {
  it('genera una clave nueva, distinta de la anterior', () => {
    const storage = buildMemoryStorage();
    const original = getOrCreateIdempotencyKey(storage, 'test-key');

    const rotated = rotateIdempotencyKey(storage, 'test-key');

    expect(rotated).not.toBe(original);
  });

  it('persiste la clave rotada — una consulta posterior devuelve la nueva, no la vieja', () => {
    const storage = buildMemoryStorage();
    getOrCreateIdempotencyKey(storage, 'test-key');

    const rotated = rotateIdempotencyKey(storage, 'test-key');
    const readAfter = getOrCreateIdempotencyKey(storage, 'test-key');

    expect(readAfter).toBe(rotated);
  });
});
