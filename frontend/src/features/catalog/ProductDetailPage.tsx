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
import { getColors, getProduct, getSizes, updateProduct } from './api';
import type { ProductFormValues } from './api';
import { ProductForm } from './components/ProductForm';
import { EditVariantModal } from './components/EditVariantModal';
import { EditPriceModal } from './components/EditPriceModal';
import { IngresoMercaderiaModal } from './components/IngresoMercaderiaModal';
import { AjusteStockModal } from './components/AjusteStockModal';
import type { Color, ProductWithVariants, Size, Variant } from './types';

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
  const [sizes, setSizes] = useState<Size[]>([]);
  const [colors, setColors] = useState<Color[]>([]);

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

  // Ticket nuevo (post Release Candidate) — hallazgo real navegando el
  // sistema: esta pantalla nunca mostraba talle/color de una variante,
  // en ninguna tabla ni modal — la única forma de distinguir filas era
  // el SKU, que no siempre lo dice. `Variant` (T2.x) solo trae
  // `sizeId`/`colorId` crudos (sin el `include` correspondiente en el
  // backend, evitando tocarlo por un dato que solo hace falta para
  // mostrar) — se resuelven acá con el mismo patrón ya usado en
  // `NewVariantPage.tsx`/`VariantGridPage.tsx` (`getSizes`/`getColors`,
  // tablas de referencia globales, no por producto — se piden una sola
  // vez, no en cada cambio de `id`).
  useEffect(() => {
    getSizes()
      .then(setSizes)
      .catch(() => undefined);
    getColors()
      .then(setColors)
      .catch(() => undefined);
  }, []);

  const sizeById = new Map(sizes.map((s) => [s.id, s]));
  const colorById = new Map(colors.map((c) => [c.id, c]));

  // Usado tanto en las columnas de la tabla como en el título de cada
  // modal de variante — sin talle/color (producto sin variación, ej.
  // un cinturón), cae al SKU para no dejar el título vacío.
  function varianteLabel(variant: Variant): string {
    const partes = [
      variant.sizeId !== null ? sizeById.get(variant.sizeId)?.nombre : null,
      variant.colorId !== null ? colorById.get(variant.colorId)?.nombre : null,
    ].filter((parte): parte is string => Boolean(parte));
    return partes.length > 0 ? partes.join(' / ') : variant.sku;
  }

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
              <Table.Th>Talle</Table.Th>
              <Table.Th>Color</Table.Th>
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
                <Table.Td>
                  {variant.sizeId !== null
                    ? (sizeById.get(variant.sizeId)?.nombre ?? '—')
                    : '—'}
                </Table.Td>
                <Table.Td>
                  {variant.colorId !== null
                    ? (colorById.get(variant.colorId)?.nombre ?? '—')
                    : '—'}
                </Table.Td>
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
          label={varianteLabel(activeModal.variant)}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
      {activeModal?.type === 'editPrice' && (
        <EditPriceModal
          variant={activeModal.variant}
          label={varianteLabel(activeModal.variant)}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
      {activeModal?.type === 'ingreso' && (
        <IngresoMercaderiaModal
          variant={activeModal.variant}
          label={varianteLabel(activeModal.variant)}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
      {activeModal?.type === 'ajuste' && (
        <AjusteStockModal
          variant={activeModal.variant}
          label={varianteLabel(activeModal.variant)}
          onClose={() => setActiveModal(null)}
          onSaved={handleVariantSaved}
        />
      )}
    </Stack>
  );
}
