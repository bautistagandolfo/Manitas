// Ticket nuevo (post Release Candidate, BLUEPRINT §8.4) — tipos que
// reflejan las respuestas del backend (`customers`, ticket nuevo).
export interface Customer {
  id: number;
  nombre: string;
  dni: string;
  telefono: string | null;
  activo: boolean;
}

// `GET /customers/:id/credito` — mismo cálculo que `CreditoDevolucionInfo`
// (`features/returns/types.ts`, T5.8) pero por cliente: una entrada por
// cada devolución suya que todavía tiene saldo (>0) sin gastar.
export interface CreditoPorReturn {
  returnId: number;
  numero: number;
  creditoDisponible: string;
}
