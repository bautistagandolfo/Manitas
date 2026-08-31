import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
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
import {
  actualizarCliente,
  buscarClientes,
  creditoDisponibleDeCliente,
} from './api';
import { NuevoClienteModal } from './components/NuevoClienteModal';
import { EditarClienteModal } from './components/EditarClienteModal';
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
//
// Ticket nuevo (post Release Candidate) — segunda vuelta, pedido directo:
// "de igual forma que editar o dar de baja, por si por ejemplo ponemos
// mal datos". Se agrega alta/edición/baja acá mismo (reusando
// `NuevoClienteModal` ya construido para el alta desde Devoluciones, más
// `EditarClienteModal` nuevo). `incluirInactivos: true` en la búsqueda:
// esta pantalla es la única que necesita ver también los dados de baja,
// para poder reactivarlos si se dieron de baja por error.
export function ClientesPage() {
  const [query, setQuery] = useState('');
  const [debouncedQuery] = useDebouncedValue(query, 200);
  const [filas, setFilas] = useState<FilaCliente[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  const [nuevoOpen, setNuevoOpen] = useState(false);
  const [editando, setEditando] = useState<Customer | null>(null);
  const [confirmandoBaja, setConfirmandoBaja] = useState<Customer | null>(null);
  const [cambiandoEstadoId, setCambiandoEstadoId] = useState<number | null>(
    null,
  );
  const [errorAccion, setErrorAccion] = useState<string | null>(null);

  const [trackedQuery, setTrackedQuery] = useState(debouncedQuery);
  if (debouncedQuery !== trackedQuery) {
    setTrackedQuery(debouncedQuery);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;

    buscarClientes(debouncedQuery, true)
      .then(async (clientes) => {
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
  }, [debouncedQuery, refreshKey]);

  function recargar(): void {
    setRefreshKey((key) => key + 1);
  }

  async function cambiarEstado(
    cliente: Customer,
    activo: boolean,
  ): Promise<void> {
    setErrorAccion(null);
    setCambiandoEstadoId(cliente.id);
    try {
      await actualizarCliente(cliente.id, { activo });
      setConfirmandoBaja(null);
      recargar();
    } catch (err) {
      setErrorAccion(
        err instanceof ApiError
          ? err.message
          : 'No se pudo guardar el cambio. Probá de nuevo.',
      );
    } finally {
      setCambiandoEstadoId(null);
    }
  }

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Clientes</Title>
        <Button onClick={() => setNuevoOpen(true)}>+ Nuevo cliente</Button>
      </Group>

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
      {errorAccion && (
        <Alert
          color="red"
          title="No se pudo guardar"
          onClose={() => setErrorAccion(null)}
          withCloseButton
        >
          {errorAccion}
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
              <Table.Th>Estado</Table.Th>
              <Table.Th>Acciones</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filas?.map(({ cliente, saldoAFavorCents }) => (
              <Table.Tr key={cliente.id} opacity={cliente.activo ? 1 : 0.6}>
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
                <Table.Td>
                  {cliente.activo ? (
                    <Badge color="green" variant="light">
                      Activo
                    </Badge>
                  ) : (
                    <Badge color="gray" variant="light">
                      De baja
                    </Badge>
                  )}
                </Table.Td>
                <Table.Td>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => setEditando(cliente)}
                    >
                      Editar
                    </Button>
                    {cliente.activo ? (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() => setConfirmandoBaja(cliente)}
                      >
                        Dar de baja
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="green"
                        loading={cambiandoEstadoId === cliente.id}
                        onClick={() => void cambiarEstado(cliente, true)}
                      >
                        Reactivar
                      </Button>
                    )}
                  </Group>
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
            : 'Todavía no hay clientes cargados.'}
        </Text>
      )}

      {nuevoOpen && (
        <NuevoClienteModal
          onClose={() => setNuevoOpen(false)}
          onCreated={() => {
            setNuevoOpen(false);
            recargar();
          }}
        />
      )}

      {editando && (
        <EditarClienteModal
          cliente={editando}
          onClose={() => setEditando(null)}
          onUpdated={() => {
            setEditando(null);
            recargar();
          }}
        />
      )}

      {confirmandoBaja && (
        <Modal
          opened
          onClose={() => setConfirmandoBaja(null)}
          title="Dar de baja"
        >
          <Stack>
            <Text size="sm">
              {confirmandoBaja.nombre} no va a aparecer más en las búsquedas de
              devoluciones ni de cobro. Se puede reactivar en cualquier momento
              desde esta misma pantalla.
            </Text>
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => setConfirmandoBaja(null)}
                disabled={cambiandoEstadoId === confirmandoBaja.id}
              >
                Cancelar
              </Button>
              <Button
                color="red"
                loading={cambiandoEstadoId === confirmandoBaja.id}
                onClick={() => void cambiarEstado(confirmandoBaja, false)}
              >
                Dar de baja
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
