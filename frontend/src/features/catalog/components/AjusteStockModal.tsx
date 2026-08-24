import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../../lib/http-client';
import { parseNumberInputValue } from '../../../lib/number-input';
import { registrarAjuste } from '../api';
import type { Variant } from '../types';

interface AjusteStockModalProps {
  variant: Variant;
  onClose: () => void;
  onSaved: (variant: Variant) => void;
}

interface FormValues {
  delta: number | '';
  motivo: string;
}

// OWNER-only (RN-5, literal), motivo siempre obligatorio.
export function AjusteStockModal({
  variant,
  onClose,
  onSaved,
}: AjusteStockModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    initialValues: { delta: '', motivo: '' },
    validate: {
      delta: (value) =>
        typeof value === 'number' && value !== 0
          ? null
          : 'Ingresá un ajuste distinto de 0',
      motivo: (value) =>
        value.trim().length > 0 ? null : 'El motivo es obligatorio',
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    if (typeof values.delta !== 'number') return;
    setError(null);
    setSubmitting(true);
    try {
      const updated = await registrarAjuste({
        variantId: variant.id,
        delta: values.delta,
        motivo: values.motivo.trim(),
      });
      onSaved(updated);
    } catch (err) {
      // "No hay stock suficiente: quedan 2 unidades" ya viene en estos
      // términos del backend (BLUEPRINT §12.6) — se muestra tal cual.
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar el ajuste. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal opened onClose={onClose} title={`Ajuste de stock — ${variant.sku}`}>
      <form onSubmit={handleSubmit}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo registrar">
              {error}
            </Alert>
          )}
          <Text size="sm" c="dimmed">
            Stock actual: {variant.stockActual}
          </Text>
          <NumberInput
            label="Ajuste (positivo suma, negativo resta)"
            step={1}
            disabled={submitting}
            value={form.values.delta}
            onChange={(value) =>
              form.setFieldValue('delta', parseNumberInputValue(value))
            }
            error={form.errors.delta}
          />
          <Textarea
            label="Motivo"
            placeholder="Conteo físico, rotura, etc."
            disabled={submitting}
            {...form.getInputProps('motivo')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Registrar ajuste
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
