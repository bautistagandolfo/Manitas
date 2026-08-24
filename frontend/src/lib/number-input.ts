// Mantine NumberInput.onChange puede devolver `string` en vez de `number`
// cuando el input usa `decimalScale`/`fixedDecimalScale`/`prefix` (tipo
// real: `NumberInputValue<T> = T | string` en @mantine/core) — asumir
// `typeof value === 'number'` deja el campo silenciosamente vacío apenas
// se escribe, sin ningún error visible (confirmado a mano en el
// navegador durante T2.12). Este helper normaliza ambos casos a un
// `number` real, o `''` si no es un valor numérico válido — se usa en
// todos los `onChange` de `NumberInput` de la app.
export function parseNumberInputValue(value: string | number): number | '' {
  if (typeof value === 'number') return value;
  if (value.trim() === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '';
}
