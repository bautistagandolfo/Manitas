import { httpClient } from '../../lib/http-client';
import type { CashMovement, CashRegisterSession } from './types';

// 404 si no hay ninguna sesión ABIERTA (T3.5) — quien llama lo interpreta
// como "no hay caja abierta", no como un error de red.
export function getOpenSession(): Promise<CashRegisterSession> {
  return httpClient.get<CashRegisterSession>('/cash-registers/sessions/open');
}

export function openSession(
  montoInicial: string,
): Promise<CashRegisterSession> {
  return httpClient.post<CashRegisterSession>('/cash-registers/sessions', {
    montoInicial,
  });
}

// Ticket nuevo (post Release Candidate) — sugerencia (no bloqueo,
// decisión explícita del usuario) para precargar "Monto inicial" con lo
// que declaró la última sesión cerrada. `null` si nunca hubo ninguna.
export function getLastClosedAmount(): Promise<{
  montoDeclarado: string | null;
}> {
  return httpClient.get<{ montoDeclarado: string | null }>(
    '/cash-registers/sessions/last-closed',
  );
}

export interface CloseSessionData {
  montoDeclarado: string;
  notaCierre?: string;
}

// RN-6, "cierre a ciegas": cualquier rol puede cerrar. El backend decide
// si exige `notaCierre` (solo OWNER, solo si la diferencia supera el
// umbral) — este cliente no duplica esa regla, solo la deja pasar y
// muestra el error si el backend la rechaza.
export function closeSession(
  sessionId: number,
  data: CloseSessionData,
): Promise<CashRegisterSession> {
  return httpClient.post<CashRegisterSession>(
    `/cash-registers/sessions/${sessionId}/close`,
    data,
  );
}

export interface ManualMovementData {
  monto: string;
  descripcion: string;
}

// AMB-13 (RESUELTA): OWNER-only. Idempotente (RN-12, §9.7) — la clave la
// genera quien llama (ver lib/idempotency.ts), acá solo viaja como header.
export function registrarIngreso(
  data: ManualMovementData,
  idempotencyKey: string,
): Promise<CashMovement> {
  return httpClient.post<CashMovement>(
    '/cash-registers/movements/ingreso',
    data,
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

export function registrarRetiro(
  data: ManualMovementData,
  idempotencyKey: string,
): Promise<CashMovement> {
  return httpClient.post<CashMovement>(
    '/cash-registers/movements/retiro',
    data,
    { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}
