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
import { formatCurrency } from '../../../lib/format';
import { closeSession } from '../api';
import type { CashRegisterSession } from '../types';

interface CloseSessionModalProps {
  session: CashRegisterSession;
  isOwner: boolean;
  onClose: () => void;
  onClosed: (session: CashRegisterSession) => void;
}

interface FormValues {
  montoDeclarado: number | '';
  notaCierre: string;
}

// RN-6, "cierre a ciegas" (§5.5): cualquier rol cierra declarando el
// efectivo contado. Un SELLER nunca ve `montoSistema` (ya viene ausente
// de `session`, RN-3-style omisión de campo) y su nota es siempre
// opcional, con un enunciado neutral — pedírsela igual que a un OWNER
// revelaría que hay una diferencia, justo lo que se le oculta. El
// backend es quien decide si la nota es obligatoria (RN-5, umbral +
// OWNER); acá no se duplica esa regla, solo se muestra el error si lo
// rechaza.
//
// BLUEPRINT §12.6: "toda acción destructiva... pide confirmación
// explícita" — cerrar caja es irreversible, así que el botón final dice
// literalmente "Confirmar cierre de caja" en vez de un genérico
// "Guardar", y el monto en sistema (si se conoce) queda a la vista antes
// de confirmar.
export function CloseSessionModal({
  session,
  isOwner,
  onClose,
  onClosed,
}: CloseSessionModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    initialValues: { montoDeclarado: '', notaCierre: '' },
    validate: {
      montoDeclarado: (value) =>
        typeof value === 'number' && value >= 0
          ? null
          : 'Ingresá el efectivo contado (puede ser 0)',
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    if (typeof values.montoDeclarado !== 'number') return;
    setError(null);
    setSubmitting(true);
    try {
      const closed = await closeSession(session.id, {
        montoDeclarado: values.montoDeclarado.toFixed(2),
        notaCierre: values.notaCierre.trim() || undefined,
      });
      onClosed(closed);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo cerrar la caja. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Modal opened onClose={onClose} title="Cerrar caja">
      <form onSubmit={handleSubmit}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo cerrar la caja">
              {error}
            </Alert>
          )}
          <Text size="sm" c="dimmed">
            Monto inicial: {formatCurrency(session.montoInicial)}
          </Text>
          {isOwner && session.montoSistema != null && (
            <Text size="sm" c="dimmed">
              El sistema calcula ahora mismo:{' '}
              {formatCurrency(session.montoSistema)}
            </Text>
          )}
          <NumberInput
            label="Efectivo contado"
            withAsterisk
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            min={0}
            step={1}
            prefix="$ "
            disabled={submitting}
            value={form.values.montoDeclarado}
            onChange={(value) =>
              form.setFieldValue('montoDeclarado', parseNumberInputValue(value))
            }
            error={form.errors.montoDeclarado}
          />
          <Textarea
            label={
              isOwner ? 'Nota de cierre' : '¿Algo para comentar del turno?'
            }
            description={
              isOwner ? 'Obligatoria si la diferencia es grande' : 'Opcional'
            }
            disabled={submitting}
            autosize
            minRows={2}
            {...form.getInputProps('notaCierre')}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button
              type="submit"
              color="red"
              loading={submitting}
              disabled={submitting}
            >
              Confirmar cierre de caja
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
