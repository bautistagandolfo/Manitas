import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Center,
  Group,
  Loader,
  Pagination,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { ApiError } from '../../lib/http-client';
import { formatCurrency, formatDate } from '../../lib/format';
import { listarVentas } from './api';
import type { PaginatedResult, SaleListItem } from './types';

const PAGE_SIZE = 20;

const ESTADO_COLOR: Record<string, string> = {
  COMPLETADA: 'green',
  ANULADA: 'red',
};

// Ticket nuevo (post Release Candidate) — hallazgo real de uso: no
// había ninguna forma de simplemente MIRAR ventas pasadas — la única
// búsqueda existente vivía adentro de Devoluciones, pensada para
// procesar un cambio/devolución, no para consultar. Reusa `GET /sales`
// tal cual (mismo endpoint, sin @Roles() — cualquiera autenticado),
// sin filtro trae todo ordenado por más reciente primero.
export function HistorialVentasPage() {
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaginatedResult<SaleListItem> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cambiar el filtro de fechas vuelve a la página 1 y marca una carga
  // nueva — ajuste durante el render (no dentro de un efecto: un
  // `setState` síncrono ahí dispara renders en cascada,
  // `react-hooks/set-state-in-effect`), mismo patrón que `GastosPage`.
  const [trackedFiltro, setTrackedFiltro] = useState(`${desde}|${hasta}`);
  const filtroActual = `${desde}|${hasta}`;
  if (filtroActual !== trackedFiltro) {
    setTrackedFiltro(filtroActual);
    setPage(1);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;

    listarVentas({
      desde: desde || undefined,
      hasta: hasta || undefined,
      page,
      pageSize: PAGE_SIZE,
    })
      .then((data) => {
        if (!cancelled) {
          setResult(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'No se pudieron cargar las ventas. Probá de nuevo.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desde, hasta, page]);

  const pageCount = result ? Math.ceil(result.itemCount / result.pageSize) : 0;

  return (
    <Stack>
      <Title order={3}>Historial de ventas</Title>

      <Group>
        <TextInput
          label="Desde"
          type="date"
          value={desde}
          onChange={(event) => setDesde(event.currentTarget.value)}
        />
        <TextInput
          label="Hasta"
          type="date"
          value={hasta}
          onChange={(event) => setHasta(event.currentTarget.value)}
        />
      </Group>

      {error && (
        <Alert color="red" title="No se pudieron cargar las ventas">
          {error}
        </Alert>
      )}

      {loading ? (
        <Center py="xl">
          <Loader />
        </Center>
      ) : (
        <>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Número</Table.Th>
                <Table.Th>Fecha</Table.Th>
                <Table.Th>Total</Table.Th>
                <Table.Th>Estado</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result?.items.map((venta) => (
                <Table.Tr key={venta.id}>
                  <Table.Td>#{venta.numero}</Table.Td>
                  <Table.Td>{formatDate(venta.fecha)}</Table.Td>
                  <Table.Td>{formatCurrency(venta.total)}</Table.Td>
                  <Table.Td>
                    <Badge
                      variant="light"
                      color={ESTADO_COLOR[venta.estado] ?? 'gray'}
                    >
                      {venta.estado}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {result && result.items.length === 0 && (
            <Text c="dimmed" ta="center" py="xl">
              No hay ventas en este período.
            </Text>
          )}

          {pageCount > 1 && (
            <Center>
              <Pagination total={pageCount} value={page} onChange={setPage} />
            </Center>
          )}
        </>
      )}
    </Stack>
  );
}
