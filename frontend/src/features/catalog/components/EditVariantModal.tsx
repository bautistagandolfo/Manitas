import { useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Group,
  Modal,
  Stack,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../../lib/http-client';
import { updateVariant } from '../api';
import type { Variant } from '../types';

interface EditVariantModalProps {
  variant: Variant;
  onClose: () => void;
  onSaved: (variant: Variant) => void;
}

interface FormValues {
  sku: string;
  barcode: string;
  activo: boolean;
}

// Abierto a cualquier rol (spec del módulo §8): sku/barcode/activo no
// están en la lista de exclusiones de SELLER — solo precio y costo lo
// están.
export function EditVariantModal({
  variant,
  onClose,
  onSaved,
}: EditVariantModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    initialValues: {
      sku: variant.sku,
      barcode: variant.barcode ?? '',
      activo: variant.activo,
    },
    validate: {
      sku: (value) =>
        value.trim().length > 0 ? null : 'El SKU es obligatorio',
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setError(null);
    setSubmitting(true);
    try {
      const updated = await updateVariant(variant.id, {
        sku: values.sku.trim(),
        barcode: values.barcode.trim() || undefined,
        activo: values.activo,
      });
      onSaved(updated);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo guardar la variante. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal opened onClose={onClose} title="Editar variante">
      <form onSubmit={handleSubmit}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo guardar">
              {error}
            </Alert>
          )}
          <TextInput
            label="SKU"
            disabled={submitting}
            {...form.getInputProps('sku')}
          />
          <TextInput
            label="Código de barras"
            placeholder="Opcional"
            disabled={submitting}
            {...form.getInputProps('barcode')}
          />
          <Checkbox
            label="Activa"
            disabled={submitting}
            {...form.getInputProps('activo', { type: 'checkbox' })}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" loading={submitting}>
              Guardar
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
