import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../../lib/http-client';
import { formatCurrency } from '../../../lib/format';
import { parseNumberInputValue } from '../../../lib/number-input';
import { updateVariantPrice } from '../api';
import type { Variant } from '../types';

interface EditPriceModalProps {
  variant: Variant;
  onClose: () => void;
  onSaved: (variant: Variant) => void;
}

interface FormValues {
  precioVenta: number | '';
}

// OWNER-only (AMB-11, RESUELTA) — la ruta que la abre ya está gateada,
// esto es solo el formulario.
export function EditPriceModal({
  variant,
  onClose,
  onSaved,
}: EditPriceModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    initialValues: { precioVenta: Number(variant.precioVenta) },
    validate: {
      precioVenta: (value) =>
        typeof value === 'number' && value > 0
          ? null
          : 'Tiene que ser mayor a 0',
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    if (typeof values.precioVenta !== 'number') return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await updateVariantPrice(
        variant.id,
        values.precioVenta.toFixed(2),
      );
      onSaved(updated);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo guardar el precio. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal opened onClose={onClose} title={`Editar precio — ${variant.sku}`}>
      <form onSubmit={handleSubmit}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo guardar">
              {error}
            </Alert>
          )}
          <Text size="sm" c="dimmed">
            Precio actual: {formatCurrency(variant.precioVenta)}
          </Text>
          <NumberInput
            label="Precio nuevo"
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            min={0.01}
            step={1}
            prefix="$ "
            disabled={submitting}
            value={form.values.precioVenta}
            onChange={(value) =>
              form.setFieldValue('precioVenta', parseNumberInputValue(value))
            }
            error={form.errors.precioVenta}
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
