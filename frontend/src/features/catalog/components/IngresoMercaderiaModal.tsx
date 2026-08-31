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
import { parseNumberInputValue } from '../../../lib/number-input';
import { registrarEntrada } from '../api';
import type { Variant } from '../types';

interface IngresoMercaderiaModalProps {
  variant: Variant;
  // Ticket nuevo (post Release Candidate) — ver `EditVariantModal.tsx`.
  label: string;
  onClose: () => void;
  onSaved: (variant: Variant) => void;
}

interface FormValues {
  cantidad: number | '';
  costoUnitario: number | '';
}

// OWNER-only (AMB-11, RESUELTA). Sin Idempotency-Key en el pedido: la
// misma decisión consciente de T2.5 — el botón se deshabilita apenas se
// aprieta (BLUEPRINT §12.6) como única mitigación de doble click acá.
export function IngresoMercaderiaModal({
  variant,
  label,
  onClose,
  onSaved,
}: IngresoMercaderiaModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    initialValues: {
      cantidad: '',
      costoUnitario: Number(variant.costoActual ?? 0),
    },
    validate: {
      cantidad: (value) =>
        typeof value === 'number' && value > 0
          ? null
          : 'Tiene que ser mayor a 0',
      costoUnitario: (value) =>
        typeof value === 'number' && value > 0
          ? null
          : 'Tiene que ser mayor a 0',
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    if (
      typeof values.cantidad !== 'number' ||
      typeof values.costoUnitario !== 'number'
    ) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const updated = await registrarEntrada({
        variantId: variant.id,
        cantidad: values.cantidad,
        costoUnitario: values.costoUnitario.toFixed(2),
      });
      onSaved(updated);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar el ingreso. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal opened onClose={onClose} title={`Ingreso de mercadería — ${label}`}>
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
            label="Cantidad que ingresa"
            withAsterisk
            min={1}
            step={1}
            disabled={submitting}
            value={form.values.cantidad}
            onChange={(value) =>
              form.setFieldValue('cantidad', parseNumberInputValue(value))
            }
            error={form.errors.cantidad}
          />
          <NumberInput
            label="Costo unitario de esta entrada"
            withAsterisk
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            min={0.01}
            step={1}
            prefix="$ "
            disabled={submitting}
            value={form.values.costoUnitario}
            onChange={(value) =>
              form.setFieldValue('costoUnitario', parseNumberInputValue(value))
            }
            error={form.errors.costoUnitario}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Registrar ingreso
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
