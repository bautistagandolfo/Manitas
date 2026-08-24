import { useCallback, useState } from 'react';

// BLUEPRINT §9.7/§12.1: la clave de idempotencia se genera al abrir el
// formulario, no al enviarlo, y se guarda en sessionStorage — si un F5
// reconstruyera una clave nueva, un reenvío duplicaría la operación
// (mismo riesgo que la venta: "el borrador se conserva junto con su
// clave de idempotencia").
//
// La lógica de storage vive en funciones puras, separadas del hook de
// React, para poder probarla con Vitest sin un entorno de navegador
// (el proyecto corre los tests en `environment: 'node'` — sin DOM real).
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getOrCreateIdempotencyKey(
  storage: KeyValueStorage,
  storageKey: string,
): string {
  const existing = storage.getItem(storageKey);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  storage.setItem(storageKey, fresh);
  return fresh;
}

// Se llama después de un envío exitoso — la clave usada ya "se gastó" (el
// backend la asoció a un movimiento real). Reusarla para la próxima
// acción, aunque sea legítima y distinta, haría que el backend la trate
// como el mismo pedido y devuelva el resultado viejo en vez de crear el
// movimiento nuevo.
export function rotateIdempotencyKey(
  storage: KeyValueStorage,
  storageKey: string,
): string {
  const fresh = crypto.randomUUID();
  storage.setItem(storageKey, fresh);
  return fresh;
}

export function useIdempotencyKey(storageKey: string): {
  key: string;
  rotate: () => void;
} {
  const [key, setKey] = useState<string>(() =>
    getOrCreateIdempotencyKey(sessionStorage, storageKey),
  );

  const rotate = useCallback(() => {
    setKey(rotateIdempotencyKey(sessionStorage, storageKey));
  }, [storageKey]);

  return { key, rotate };
}
