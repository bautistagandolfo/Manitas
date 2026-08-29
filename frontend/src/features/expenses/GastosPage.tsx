import { useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
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
import { getExpenseCategories, getExpenses } from './api';
import type { Expense, ExpenseCategory, PaginatedResult } from './types';
import { RegistrarGastoModal } from './components/RegistrarGastoModal';

const PAGE_SIZE = 20;

const MEDIO_PAGO_LABELS: Record<Expense['medioPago'], string> = {
  EFECTIVO: 'Efectivo',
  TRANSFERENCIA: 'Transferencia',
  OTRO: 'Otro',
};

// T6.8 — RN-2 (OWNER-only, ya cubierto por `RequireOwner` en el router):
// listado paginado en el servidor (§12.4, "lo último siempre arriba" —
// `GET /expenses` ya ordena por fecha descendente) + alta de gasto.
export function GastosPage() {
  const [categorias, setCategorias] = useState<ExpenseCategory[]>([]);
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<PaginatedResult<Expense> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [registrando, setRegistrando] = useState(false);
  // Disparador de recarga manual (después de registrar un gasto nuevo),
  // sin pisar el `desde`/`hasta` que el usuario ya eligió — separado del
  // seguimiento de filtro de abajo para no confundir "cambió el filtro"
  // con "hay que refrescar con el mismo filtro".
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    getExpenseCategories()
      .then(setCategorias)
      .catch(() => {
        // El nombre de categoría cae a "—" si esto falla (ver `nombreCategoria`
        // abajo) — no es motivo para bloquear el listado de gastos en sí.
      });
  }, []);

  // Cambiar el filtro de fechas vuelve a la página 1 y marca una carga
  // nueva — ajuste durante el render (no dentro de un efecto: un
  // `setState` síncrono ahí dispara renders en cascada,
  // `react-hooks/set-state-in-effect`), mismo patrón que `CatalogPage`.
  const [trackedFiltro, setTrackedFiltro] = useState(`${desde}|${hasta}`);
  const filtroActual = `${desde}|${hasta}`;
  if (filtroActual !== trackedFiltro) {
    setTrackedFiltro(filtroActual);
    setPage(1);
    setLoading(true);
  }

  // Recarga manual (después de registrar un gasto), sin resetear la
  // página — mismo ajuste durante el render que el de arriba.
  const [trackedReload, setTrackedReload] = useState(reloadToken);
  if (reloadToken !== trackedReload) {
    setTrackedReload(reloadToken);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;

    getExpenses({
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
              : 'No se pudieron cargar los gastos. Probá de nuevo.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [desde, hasta, page, reloadToken]);

  function nombreCategoria(id: number): string {
    return categorias.find((c) => c.id === id)?.nombre ?? '—';
  }

  const pageCount = result ? Math.ceil(result.itemCount / result.pageSize) : 0;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Gastos</Title>
        <Button onClick={() => setRegistrando(true)}>+ Registrar gasto</Button>
      </Group>

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
        <Alert color="red" title="No se pudieron cargar los gastos">
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
                <Table.Th>Fecha</Table.Th>
                <Table.Th>Categoría</Table.Th>
                <Table.Th>Descripción</Table.Th>
                <Table.Th>Medio</Table.Th>
                <Table.Th>Monto</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result?.items.map((gasto) => (
                <Table.Tr key={gasto.id}>
                  <Table.Td>{formatDate(gasto.fecha)}</Table.Td>
                  <Table.Td>
                    {nombreCategoria(gasto.expenseCategoryId)}
                  </Table.Td>
                  <Table.Td>{gasto.descripcion}</Table.Td>
                  <Table.Td>
                    <Badge variant="light">
                      {MEDIO_PAGO_LABELS[gasto.medioPago]}
                    </Badge>
                  </Table.Td>
                  <Table.Td>{formatCurrency(gasto.monto)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {result && result.items.length === 0 && (
            <Text c="dimmed" ta="center" py="xl">
              No hay gastos registrados en este período.
            </Text>
          )}

          {pageCount > 1 && (
            <Center>
              <Pagination total={pageCount} value={page} onChange={setPage} />
            </Center>
          )}
        </>
      )}

      {registrando && (
        <RegistrarGastoModal
          onClose={() => setRegistrando(false)}
          onSaved={() => {
            setRegistrando(false);
            setPage(1);
            setReloadToken((token) => token + 1);
          }}
        />
      )}
    </Stack>
  );
}
