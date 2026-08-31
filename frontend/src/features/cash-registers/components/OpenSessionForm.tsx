import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  NumberInput,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../../lib/http-client';
import { formatCurrency } from '../../../lib/format';
import { parseNumberInputValue } from '../../../lib/number-input';
import { getLastClosedAmount, openSession } from '../api';

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
  // Ticket nuevo (post Release Candidate) — hallazgo real de una
  // conversación con el usuario: nada conectaba el cierre de una
  // sesión con la apertura de la siguiente, ni siquiera como
  // sugerencia. `null` mientras carga o si nunca hubo un cierre
  // previo (primera vez que se abre caja en la vida del sistema) — en
  // ambos casos el campo arranca vacío, igual que antes de este
  // ticket.
  const [ultimoCierre, setUltimoCierre] = useState<string | null>(null);

  const form = useForm<FormValues>({
    initialValues: { montoInicial: '' },
    validate: {
      montoInicial: (value) =>
        typeof value === 'number' && value >= 0
          ? null
          : 'Ingresá el monto con el que arranca la caja (puede ser 0)',
    },
  });

  useEffect(() => {
    let cancelled = false;
    getLastClosedAmount()
      .then((data) => {
        if (cancelled || data.montoDeclarado === null) return;
        setUltimoCierre(data.montoDeclarado);
        // Precarga, no bloqueo (decisión explícita del usuario): sigue
        // siendo un `NumberInput` común, se puede cambiar sin ninguna
        // fricción — mismo espíritu que el "cierre a ciegas" ya
        // confiado del resto de este módulo.
        form.setFieldValue('montoInicial', Number(data.montoDeclarado));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              withAsterisk
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
            {ultimoCierre !== null && (
              <Text size="xs" c="dimmed">
                Sugerido: la última caja cerró con{' '}
                {formatCurrency(ultimoCierre)} — cambialo si el efectivo contado
                hoy es distinto.
              </Text>
            )}
            <Button type="submit" loading={submitting} disabled={submitting}>
              Abrir caja
            </Button>
          </Stack>
        </form>
      </Paper>
    </Stack>
  );
}
