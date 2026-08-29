import { httpClient } from '../../lib/http-client';
import type { Setting } from './types';

// BLUEPRINT §3.8: "Solo OWNER los modifica" — GET también queda
// OWNER-only en el backend (T6.9), esta pantalla es la única
// consumidora de esta ruta.
export function getSettings(): Promise<Setting[]> {
  return httpClient.get<Setting[]>('/settings');
}

export function updateSetting(clave: string, valor: string): Promise<Setting> {
  return httpClient.patch<Setting>(`/settings/${clave}`, { valor });
}
