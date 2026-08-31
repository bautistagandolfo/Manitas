import { useEffect, useState } from 'react';
import {
  Alert,
  Center,
  Loader,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { ApiError } from '../../lib/http-client';
import { formatCurrency } from '../../lib/format';
import { centsToAmountString, toCents } from '../sales/cart';
import { buscarClientes, creditoDisponibleDeCliente } from './api';
import type { Customer } from './types';

interface FilaCliente {
  cliente: Customer;
  saldoAFavorCents: number | null;
}

// Ticket nuevo (post Release Candidate) — pregunta directa del usuario:
// "cuando se genera una nota de crédito, ¿se la asigna finalmente a un
// cliente? ¿sería muy complicado agregar una pantalla que nos los
// muestre?". Respuesta corta: sí se le asigna (si alguien elige un
// cliente al procesar la devolución en `DevolucionPage.tsx` — es
// opcional, no automático) y esta pantalla no fue complicada ni de
// riesgo: es de solo lectura, reusa `GET /customers` y `GET
// /customers/:id/credito` tal cual (ya construidos y probados en vivo
// hoy) — no toca ningún camino de escritura de plata/stock, cero
// riesgo de romper algo. Sin @Roles(): mismo criterio que el resto del
// módulo de clientes (un SELLER ya ve el saldo a favor de un cliente
// al buscarlo en `CobroPage.tsx`, esto no revela nada nuevo).
export function ClientesPage() {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 200);
  const [filas, setFilas] = useState<FilaCliente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Mismo patrón que el resto de la app: cuando cambia la búsqueda,
  // marca una carga nueva durante el render, no dentro del efecto
  // (react-hooks/set-state-in-effect).
  const [trackedQuery, setTrackedQuery] = useState(debouncedQuery);
  if (debouncedQuery !== trackedQuery) {
    setTrackedQuery(debouncedQuery);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;

    buscarClientes(debouncedQuery)
      .then(async (clientes) => {
        // El saldo a favor de cada cliente es una consulta aparte (la
        // suma de sus devoluciones con crédito todavía sin gastar,
        // `GET /customers/:id/credito`) — se piden todas en paralelo,
        // la lista de clientes nunca pasa de unas pocas decenas.
        const saldos = await Promise.all(
          clientes.map((cliente) =>
            creditoDisponibleDeCliente(cliente.id)
              .then((creditos) =>
                creditos.reduce(
                  (acc, c) => acc + toCents(c.creditoDisponible),
                  0,
                ),
              )
              .catch(() => null),
          ),
        );
        if (cancelled) return;
        setFilas(
          clientes.map((cliente, index) => ({
            cliente,
            saldoAFavorCents: saldos[index],
          })),
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFilas(null);
        setError(
          err instanceof ApiError
            ? err.message
            : 'No se pudieron cargar los clientes. Probá de nuevo.',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  return (
    <Stack>
      <Title order={3}>Clientes</Title>

      <TextInput
        placeholder="Buscá por nombre o DNI…"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        maw={360}
      />

      {error && (
        <Alert color="red" title="No se pudieron cargar los clientes">
          {error}
        </Alert>
      )}

      {loading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Nombre</Table.Th>
              <Table.Th>DNI</Table.Th>
              <Table.Th>Teléfono</Table.Th>
              <Table.Th>Saldo a favor</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filas?.map(({ cliente, saldoAFavorCents }) => (
              <Table.Tr key={cliente.id}>
                <Table.Td>{cliente.nombre}</Table.Td>
                <Table.Td>{cliente.dni}</Table.Td>
                <Table.Td>{cliente.telefono ?? '—'}</Table.Td>
                <Table.Td>
                  {saldoAFavorCents === null ? (
                    '—'
                  ) : saldoAFavorCents > 0 ? (
                    <Text c="green" fw={600}>
                      {formatCurrency(centsToAmountString(saldoAFavorCents))}
                    </Text>
                  ) : (
                    <Text c="dimmed">Sin saldo</Text>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {!loading && filas?.length === 0 && (
        <Text c="dimmed" ta="center" py="xl">
          {debouncedQuery.trim()
            ? 'No se encontró ningún cliente con ese nombre o DNI.'
            : 'Todavía no hay clientes cargados — se agregan desde Devoluciones al procesar un cambio o devolución.'}
        </Text>
      )}
    </Stack>
  );
}
