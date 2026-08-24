import { useState } from 'react';
import { Alert, Button, NumberInput, Paper, Stack, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../../lib/http-client';
import { parseNumberInputValue } from '../../../lib/number-input';
import { openSession } from '../api';

interface OpenSessionFormProps {
  // Sin argumento a propósito: la fila que devuelve `POST /sessions`
  // (T3.1) no trae `montoSistema` recalculado — quien escucha este
  // evento tiene que recargar vía `GET /sessions/open` (T3.5) para
  // mostrarlo, no reusar la respuesta cruda del alta.
  onOpened: () => void;
}

interface FormValues {
  montoInicial: number | '';
}

// RN-1/RN-2 (§5.5): cualquier rol puede abrir — una vendedora tiene que
// poder arrancar el día sola. 0 es un valor válido (turno sin cambio).
export function OpenSessionForm({ onOpened }: OpenSessionFormProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    initialValues: { montoInicial: '' },
    validate: {
      montoInicial: (value) =>
        typeof value === 'number' && value >= 0
          ? null
          : 'Ingresá el monto con el que arranca la caja (puede ser 0)',
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    if (typeof values.montoInicial !== 'number') return;
    setError(null);
    setSubmitting(true);
    try {
      await openSession(values.montoInicial.toFixed(2));
      onOpened();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo abrir la caja. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Stack maw={480}>
      <Title order={3}>Abrir caja</Title>
      <Paper withBorder p="md">
        <form onSubmit={handleSubmit}>
          <Stack>
            {error && (
              <Alert color="red" title="No se pudo abrir la caja">
                {error}
              </Alert>
            )}
            <NumberInput
              label="Monto inicial"
              description="El efectivo con el que arranca el turno"
              decimalScale={2}
              fixedDecimalScale
              decimalSeparator=","
              thousandSeparator="."
              min={0}
              step={1}
              prefix="$ "
              disabled={submitting}
              value={form.values.montoInicial}
              onChange={(value) =>
                form.setFieldValue('montoInicial', parseNumberInputValue(value))
              }
              error={form.errors.montoInicial}
            />
            <Button type="submit" loading={submitting} disabled={submitting}>
              Abrir caja
            </Button>
          </Stack>
        </form>
      </Paper>
    </Stack>
  );
}
