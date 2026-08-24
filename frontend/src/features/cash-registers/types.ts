// Tipos que reflejan las respuestas del backend (`cash-registers`,
// T3.1-T3.6). Los importes viajan como string (Decimal serializado,
// BLUEPRINT §9.3) — nunca number.

// `montoSistema`/`diferencia` ausentes si quien pregunta no es OWNER
// (RN-6, "cierre a ciegas") — nunca null, directamente no viajan.
export interface CashRegisterSession {
  id: number;
  fechaApertura: string;
  userIdApertura: number;
  montoInicial: string;
  fechaCierre: string | null;
  userIdCierre: number | null;
  montoDeclarado: string | null;
  montoSistema?: string | null;
  diferencia?: string | null;
  notaCierre: string | null;
  estado: 'ABIERTA' | 'CERRADA';
}

export interface CashMovement {
  id: number;
  sessionId: number;
  fecha: string;
  tipo:
    | 'VENTA'
    | 'DEVOLUCION'
    | 'ANULACION'
    | 'GASTO'
    | 'INGRESO_MANUAL'
    | 'RETIRO';
  monto: string;
  descripcion: string;
  userId: number;
}
