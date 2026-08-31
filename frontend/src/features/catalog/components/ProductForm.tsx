import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Select,
  Stack,
  Textarea,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../../lib/http-client';
import { createBrand, createCategory, getBrands, getCategories } from '../api';
import type { ProductFormValues } from '../api';
import type { Brand, Category } from '../types';
import { NuevoValorModal } from './NuevoValorModal';

interface ProductFormProps {
  initialValues?: ProductFormValues;
  submitLabel: string;
  onSubmit: (values: ProductFormValues) => Promise<void>;
}

// Compartido entre alta (NewProductPage) y edición (ProductDetailPage) —
// mismos campos, misma validación. Marca/categoría abiertas a cualquier
// rol (spec del módulo §8: no está en la lista de exclusiones de SELLER
// de BLUEPRINT §5.1).
export function ProductForm({
  initialValues,
  submitLabel,
  onSubmit,
}: ProductFormProps) {
  const [brands, setBrands] = useState<Brand[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nuevaMarcaOpen, setNuevaMarcaOpen] = useState(false);
  const [nuevaCategoriaOpen, setNuevaCategoriaOpen] = useState(false);

  const form = useForm<ProductFormValues>({
    initialValues: initialValues ?? {
      nombre: '',
      descripcion: '',
      brandId: undefined,
      categoryId: undefined,
    },
    validate: {
      nombre: (value) =>
        value.trim().length > 0 ? null : 'El nombre es obligatorio',
    },
  });

  function loadBrands(selectId?: number): void {
    getBrands()
      .then((data) => {
        setBrands(data.filter((b) => b.activo));
        if (selectId !== undefined) {
          form.setFieldValue('brandId', selectId);
        }
      })
      .catch(() => undefined);
  }

  function loadCategories(selectId?: number): void {
    getCategories()
      .then((data) => {
        setCategories(data.filter((c) => c.activo));
        if (selectId !== undefined) {
          form.setFieldValue('categoryId', selectId);
        }
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    loadBrands();
    loadCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = form.onSubmit(async (values) => {
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        ...values,
        descripcion: values.descripcion?.trim() || undefined,
      });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo guardar el producto. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <form onSubmit={handleSubmit}>
      <Stack>
        {error && (
          <Alert color="red" title="No se pudo guardar">
            {error}
          </Alert>
        )}
        <TextInput
          label="Nombre"
          placeholder="Campera de jean"
          disabled={submitting}
          {...form.getInputProps('nombre')}
        />
        <Textarea
          label="Descripción"
          placeholder="Opcional"
          disabled={submitting}
          {...form.getInputProps('descripcion')}
        />
        <Group align="flex-end" gap="xs">
          <Select
            label="Marca"
            placeholder="Sin marca"
            clearable
            disabled={submitting}
            data={brands.map((b) => ({ value: String(b.id), label: b.nombre }))}
            value={
              form.values.brandId !== undefined
                ? String(form.values.brandId)
                : null
            }
            onChange={(value) =>
              form.setFieldValue('brandId', value ? Number(value) : undefined)
            }
            flex={1}
          />
          <Button
            variant="default"
            onClick={() => setNuevaMarcaOpen(true)}
            disabled={submitting}
          >
            + Nueva
          </Button>
        </Group>
        <Group align="flex-end" gap="xs">
          <Select
            label="Categoría"
            placeholder="Sin categoría"
            clearable
            disabled={submitting}
            data={categories.map((c) => ({
              value: String(c.id),
              label: c.nombre,
            }))}
            value={
              form.values.categoryId !== undefined
                ? String(form.values.categoryId)
                : null
            }
            onChange={(value) =>
              form.setFieldValue(
                'categoryId',
                value ? Number(value) : undefined,
              )
            }
            flex={1}
          />
          <Button
            variant="default"
            onClick={() => setNuevaCategoriaOpen(true)}
            disabled={submitting}
          >
            + Nueva
          </Button>
        </Group>
        <Group justify="flex-end">
          <Button type="submit" loading={submitting}>
            {submitLabel}
          </Button>
        </Group>
      </Stack>

      {nuevaMarcaOpen && (
        <NuevoValorModal
          title="Nueva marca"
          label="Nombre"
          placeholder="Ej: Levi's"
          onCreate={createBrand}
          onClose={() => setNuevaMarcaOpen(false)}
          onCreated={(marca) => {
            setNuevaMarcaOpen(false);
            loadBrands(marca.id);
          }}
        />
      )}

      {nuevaCategoriaOpen && (
        <NuevoValorModal
          title="Nueva categoría"
          label="Nombre"
          placeholder="Ej: Camperas"
          onCreate={createCategory}
          onClose={() => setNuevaCategoriaOpen(false)}
          onCreated={(categoria) => {
            setNuevaCategoriaOpen(false);
            loadCategories(categoria.id);
          }}
        />
      )}
    </form>
  );
}
