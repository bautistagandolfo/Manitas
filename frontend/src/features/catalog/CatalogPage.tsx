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
import { useDebouncedValue } from '@mantine/hooks';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../../lib/http-client';
import { formatCurrency, formatNumber } from '../../lib/format';
import { searchVariants } from './api';
import type { VariantSearchResult, PaginatedResult } from './types';

const PAGE_SIZE = 20;

// RN-11/RN-12: buscador unificado (nombre de producto, SKU o código de
// barras), paginado en el servidor. Es la vista principal del catálogo —
// la variante es la unidad real de venta y de stock (MVP_SCOPE §3.2), no
// el producto.
export function CatalogPage() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.rol === 'OWNER';

  const [q, setQ] = useState('');
  const [debouncedQ] = useDebouncedValue(q, 250);
  const [page, setPage] = useState(1);
  const [result, setResult] =
    useState<PaginatedResult<VariantSearchResult> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Cuando cambia el término de búsqueda, se vuelve a la página 1 y se
  // marca una carga nueva en curso — ajustado durante el render (patrón
  // de React para "adjust state when a prop changes"), no dentro de un
  // efecto: un `setState` síncrono en el cuerpo de un efecto dispara
  // renders en cascada (react-hooks/set-state-in-effect). Un cambio de
  // solo `page` (paginar) no vuelve a mostrar el loader a propósito: se
  // deja la tabla anterior visible hasta que llega la página nueva, en
  // vez de parpadear a vacío.
  const [trackedQ, setTrackedQ] = useState(debouncedQ);
  if (debouncedQ !== trackedQ) {
    setTrackedQ(debouncedQ);
    setPage(1);
    setLoading(true);
  }

  useEffect(() => {
    let cancelled = false;

    searchVariants({ q: debouncedQ, page, pageSize: PAGE_SIZE })
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
              : 'No se pudo cargar el catálogo. Probá de nuevo.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQ, page]);

  const pageCount = result ? Math.ceil(result.itemCount / result.pageSize) : 0;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Catálogo</Title>
        <Button component={Link} to="/catalogo/productos/nuevo">
          + Nuevo producto
        </Button>
      </Group>

      <TextInput
        placeholder="Buscar por nombre, SKU o código de barras…"
        value={q}
        onChange={(event) => setQ(event.currentTarget.value)}
      />

      {error && (
        <Alert color="red" title="No se pudo cargar el catálogo">
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
                <Table.Th>Producto</Table.Th>
                <Table.Th>Talle</Table.Th>
                <Table.Th>Color</Table.Th>
                <Table.Th>SKU</Table.Th>
                <Table.Th>Precio</Table.Th>
                {isOwner && <Table.Th>Costo</Table.Th>}
                <Table.Th>Stock</Table.Th>
                <Table.Th>Estado</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result?.items.map((variant) => (
                <Table.Tr
                  key={variant.id}
                  style={{ cursor: 'pointer' }}
                  onClick={() =>
                    void navigate(`/catalogo/productos/${variant.product.id}`)
                  }
                >
                  <Table.Td>{variant.product.nombre}</Table.Td>
                  <Table.Td>{variant.size?.nombre ?? '—'}</Table.Td>
                  <Table.Td>{variant.color?.nombre ?? '—'}</Table.Td>
                  <Table.Td>{variant.sku}</Table.Td>
                  <Table.Td>{formatCurrency(variant.precioVenta)}</Table.Td>
                  {isOwner && (
                    <Table.Td>
                      {variant.costoActual !== undefined
                        ? formatCurrency(variant.costoActual)
                        : '—'}
                    </Table.Td>
                  )}
                  <Table.Td>{formatNumber(variant.stockActual)}</Table.Td>
                  <Table.Td>
                    <Badge
                      color={variant.activo ? 'green' : 'gray'}
                      variant="light"
                    >
                      {variant.activo ? 'Activo' : 'Inactivo'}
                    </Badge>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          {result && result.items.length === 0 && (
            <Text c="dimmed" ta="center" py="xl">
              No se encontraron variantes.
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
