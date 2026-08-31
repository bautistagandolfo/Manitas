import { httpClient } from '../../lib/http-client';
import type { CreditoPorReturn, Customer } from './types';

export function buscarClientes(q?: string): Promise<Customer[]> {
  const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
  return httpClient.get<Customer[]>(`/customers${qs}`);
}

export function crearCliente(data: {
  nombre: string;
  dni: string;
  telefono?: string;
}): Promise<Customer> {
  return httpClient.post<Customer>('/customers', data);
}

export function creditoDisponibleDeCliente(
  customerId: number,
): Promise<CreditoPorReturn[]> {
  return httpClient.get<CreditoPorReturn[]>(`/customers/${customerId}/credito`);
}
