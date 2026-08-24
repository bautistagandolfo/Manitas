import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Textarea,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../../lib/http-client';
import { parseNumberInputValue } from '../../../lib/number-input';
import { useIdempotencyKey } from '../../../lib/idempotency';
import { registrarIngreso, registrarRetiro } from '../api';
import type { CashMovement } from '../types';

interface ManualMovementModalProps {
  tipo: 'INGRESO_MANUAL' | 'RETIRO';
  onClose: () => void;
  onSaved: (movement: CashMovement) => void;
}

interface FormValues {
  monto: number | '';
  descripcion: string;
}

const LABELS = {
  INGRESO_MANUAL: {
    titulo: 'Ingreso manual de efectivo',
    boton: 'Registrar ingreso',
    storageKey: 'cash-registers:ingreso-idempotency-key',
  },
  RETIRO: {
    titulo: 'Retiro de efectivo',
    boton: 'Registrar retiro',
    storageKey: 'cash-registers:retiro-idempotency-key',
  },
} as const;

// AMB-13 (RESUELTA): OWNER-only, gateado por quien llama (el botón que
// abre este modal solo se muestra a OWNER — RequireOwner ya cubre las
// rutas de solo-OWNER, pero acá conviven ambos roles en la misma pantalla
// de caja). Idempotente (RN-12, §9.7): la clave se genera al abrir el
// modal, no al enviar — sobrevive a un F5 vía sessionStorage. Después de
// un envío exitoso se rota, para que la próxima acción (aunque sea del
// mismo tipo) no quede pegada al mismo movimiento.
export function ManualMovementModal({
  tipo,
  onClose,
  onSaved,
}: ManualMovementModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { titulo, boton, storageKey } = LABELS[tipo];
  const { key: idempotencyKey, rotate } = useIdempotencyKey(storageKey);

  const form = useForm<FormValues>({
    initialValues: { monto: '', descripcion: '' },
    validate: {
      monto: (value) =>
        typeof value === 'number' && value > 0
          ? null
          : 'Tiene que ser mayor a 0',
      descripcion: (value) =>
        value.trim().length > 0 ? null : 'Ingresá una descripción',
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    if (typeof values.monto !== 'number') return;
    setError(null);
    setSubmitting(true);
    try {
      const data = {
        monto: values.monto.toFixed(2),
        descripcion: values.descripcion.trim(),
      };
      const movement =
        tipo === 'INGRESO_MANUAL'
          ? await registrarIngreso(data, idempotencyKey)
          : await registrarRetiro(data, idempotencyKey);
      rotate();
      onSaved(movement);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar el movimiento. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal opened onClose={onClose} title={titulo}>
      <form onSubmit={handleSubmit}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo registrar">
              {error}
            </Alert>
          )}
          <NumberInput
            label="Monto"
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            min={0.01}
            step={1}
            prefix="$ "
            disabled={submitting}
            value={form.values.monto}
            onChange={(value) =>
              form.setFieldValue('monto', parseNumberInputValue(value))
            }
            error={form.errors.monto}
          />
          <Textarea
            label="Descripción"
            placeholder="Para qué es este movimiento"
            disabled={submitting}
            autosize
            minRows={2}
            {...form.getInputProps('descripcion')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              {boton}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
