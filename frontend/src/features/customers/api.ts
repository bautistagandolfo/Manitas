import { httpClient } from '../../lib/http-client';
import type { CreditoPorReturn, Customer } from './types';

export function buscarClientes(
  q?: string,
  incluirInactivos?: boolean,
): Promise<Customer[]> {
  const params = new URLSearchParams();
  if (q?.trim()) params.set('q', q.trim());
  if (incluirInactivos) params.set('incluirInactivos', 'true');
  const qs = params.toString();
  return httpClient.get<Customer[]>(`/customers${qs ? `?${qs}` : ''}`);
}

export function crearCliente(data: {
  nombre: string;
  dni: string;
  telefono?: string;
}): Promise<Customer> {
  return httpClient.post<Customer>('/customers', data);
}

// Ticket nuevo (post Release Candidate) — pedido directo del usuario:
// "editar o dar de baja, por si pusimos mal datos". Mismo PATCH cubre
// corregir un campo y activar/desactivar (`activo`).
export function actualizarCliente(
  id: number,
  data: Partial<{
    nombre: string;
    dni: string;
    telefono: string;
    activo: boolean;
  }>,
): Promise<Customer> {
  return httpClient.patch<Customer>(`/customers/${id}`, data);
}

export function creditoDisponibleDeCliente(
  customerId: number,
): Promise<CreditoPorReturn[]> {
  return httpClient.get<CreditoPorReturn[]>(`/customers/${customerId}/credito`);
}
