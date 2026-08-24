import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  Paper,
  Stack,
  Table,
  Title,
} from '@mantine/core';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../../lib/http-client';
import { formatCurrency, formatNumber } from '../../lib/format';
import { getProduct, updateProduct } from './api';
import type { ProductFormValues } from './api';
import { ProductForm } from './components/ProductForm';
import { EditVariantModal } from './components/EditVariantModal';
import { EditPriceModal } from './components/EditPriceModal';
import { IngresoMercaderiaModal } from './components/IngresoMercaderiaModal';
import { AjusteStockModal } from './components/AjusteStockModal';
import type { ProductWithVariants, Variant } from './types';

type ActiveModal =
  | { type: 'editProduct' }
  | { type: 'editVariant'; variant: Variant }
  | { type: 'editPrice'; variant: Variant }
  | { type: 'ingreso'; variant: Variant }
  | { type: 'ajuste'; variant: Variant }
  | null;

export function ProductDetailPage() {
  const { productId } = useParams<{ productId: string }>();
  const id = Number(productId);
  const { user } = useAuth();
  const navigate = useNavigate();
  const isOwner = user?.rol === 'OWNER';

  const [product, setProduct] = useState<ProductWithVariants | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeModal, setActiveModal] = useState<ActiveModal>(null);

  // Si `id` cambia (navegar de un producto a otro sin desmontar la
  // página), se vuelve a mostrar el loader — ajustado durante el render,
  // no en un efecto (react-hooks/set-state-in-effect: un `setState`
  // síncrono en el cuerpo de un efecto dispara renders en cascada).
  const [trackedId, setTrackedId] = useState(id);
  if (id !== trackedId) {
    setTrackedId(id);
    setLoading(true);
    setError(null);
  }

  useEffect(() => {
    let cancelled = false;

    getProduct(id)
      .then((data) => {
        if (!cancelled) {
          setProduct(data);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? err.message
              : 'No se pudo cargar el producto. Probá de nuevo.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [id]);

  const reload = useCallback(() => {
    setLoading(true);
    getProduct(id)
      .then((data) => {
        setProduct(data);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(
          err instanceof ApiError
            ? err.message
            : 'No se pudo cargar el producto. Probá de nuevo.',
        );
      })
      .finally(() => setLoading(false));
  }, [id]);

  const handleVariantSaved = (updated: Variant): void => {
    setProduct((prev) =>
      prev
        ? {
            ...prev,
            variants: prev.variants.map((v) =>
              v.id === updated.id ? updated : v,
            ),
          }
        : prev,
    );
    setActiveModal(null);
  };

  const handleProductSaved = async (
    values: ProductFormValues,
  ): Promise<void> => {
    const updated = await updateProduct(id, values);
    setProduct((prev) => (prev ? { ...prev, ...updated } : prev));
    setActiveModal(null);
  };

  if (loading) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    );
  }

  if (error || !product) {
    return (
      <Stack>
        <Alert color="red" title="No se pudo cargar el producto">
          {error ?? 'Producto no encontrado.'}
        </Alert>
        {error && (
          <Button variant="default" onClick={reload} w="fit-content">
            Reintentar
          </Button>
        )}
      </Stack>
    );
  }

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={3}>{product.nombre}</Title>
          {product.descripcion && (
            <Group c="dimmed">{product.descripcion}</Group>
          )}
        </div>
        <Group>
          <Badge color={product.activo ? 'green' : 'gray'} variant="light">
            {product.activo ? 'Activo' : 'Inactivo'}
          </Badge>
          <Button
            variant="default"
            onClick={() => setActiveModal({ type: 'editProduct' })}
          >
            Editar producto
          </Button>
        </Group>
      </Group>

      <Group>
        <Button component={Link} to={`/catalogo/productos/${id}/grilla`}>
          + Cargar por grilla
        </Button>
        <Button
          variant="default"
          component={Link}
          to={`/catalogo/productos/${id}/variantes/nueva`}
        >
          + Variante suelta
        </Button>
      </Group>

      <Paper withBorder>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>SKU</Table.Th>
              <Table.Th>Código de barras</Table.Th>
              <Table.Th>Precio</Table.Th>
              {isOwner && <Table.Th>Costo</Table.Th>}
              <Table.Th>Stock</Table.Th>
              <Table.Th>Estado</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {product.variants.map((variant) => (
              <Table.Tr key={variant.id}>
                <Table.Td>{variant.sku}</Table.Td>
                <Table.Td>{variant.barcode ?? '—'}</Table.Td>
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
                    {variant.activo ? 'Activa' : 'Inactiva'}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Button
                      variant="subtle"
                      size="xs"
                      onClick={() =>
                        setActiveModal({ type: 'editVariant', variant })
                      }
                    >
                      Editar
                    </Button>
                    {isOwner && (
                      <>
                        <Button
                          variant="subtle"
                          size="xs"
                          onClick={() =>
                            setActiveModal({ type: 'editPrice', variant })
                          }
                        >
                          Precio
                        </Button>
                        <Button
                          variant="subtle"
                          size="xs"
                          onClick={() =>
                            setActiveModal({ type: 'ingreso', variant })
                          }
                        >
                          Ingreso
                        </Button>
                        <Button
                          variant="subtle"
                          size="xs"
                          onClick={() =>
                            setActiveModal({ type: 'ajuste', variant })
                          }
                        >
                          Ajuste
                        </Button>
                      </>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
        {product.variants.length === 0 && (
          <Center py="xl">
            <span>Todavía no hay variantes cargadas.</span>
          </Center>
        )}
      </Paper>

      <Button
        variant="subtle"
        onClick={() => void navigate('/catalogo')}
        w="fit-content"
      >
        ← Volver al catálogo
      </Button>

      {activeModal?.type === 'editProduct' && (
        <Modal
          opened
          onClose={() => setActiveModal(null)}
          title="Editar producto"
        >
          <ProductForm
            initialValues={{
              nombre: product.nombre,
              descripcion: product.descripcion ?? undefined,
              brandId: product.brandId ?? undefined,
              categoryId: product.categoryId ?? undefined,
            }}
            submitLabel="Guardar"
            onSubmit={handleProductSaved}
          />
        </Modal>
      )}
      {activeModal?.type === 'editVariant' && (
        <EditVariantModal
          variant={activeModal.variant}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
      {activeModal?.type === 'editPrice' && (
        <EditPriceModal
          variant={activeModal.variant}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
      {activeModal?.type === 'ingreso' && (
        <IngresoMercaderiaModal
          variant={activeModal.variant}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
      {activeModal?.type === 'ajuste' && (
        <AjusteStockModal
          variant={activeModal.variant}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
    </Stack>
  );
}
