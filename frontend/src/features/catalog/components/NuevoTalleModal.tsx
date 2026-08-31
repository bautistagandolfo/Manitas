import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { ApiError } from '../../../lib/http-client';
import { createSize } from '../api';
import type { Size } from '../types';

interface NuevoTalleModalProps {
  ordenSugerido: number;
  onClose: () => void;
  onCreated: (size: Size) => void;
}

// Ticket nuevo (post Release Candidate) — mismo hallazgo que
// `NuevoValorModal.tsx`, pero talle necesita un campo más: `orden`
// (BLUEPRINT §3.2, "S, M, L, XL en ese orden, no alfabético"). Se
// sugiere el siguiente número libre (máximo actual + 1, calculado por
// quien llama) pero queda editable, por si hace falta insertar un
// talle en el medio (ej. "XS" antes de "S").
export function NuevoTalleModal({
  ordenSugerido,
  onClose,
  onCreated,
}: NuevoTalleModalProps) {
  const [nombre, setNombre] = useState('');
  const [orden, setOrden] = useState<number | ''>(ordenSugerido);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = nombre.trim();
    if (!trimmed) {
      setError('Ingresá un nombre');
      return;
    }
    if (typeof orden !== 'number') {
      setError('Ingresá el orden');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const size = await createSize(trimmed, orden);
      onCreated(size);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo crear. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Nuevo talle">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo crear">
              {error}
            </Alert>
          )}
          <TextInput
            label="Nombre"
            placeholder="Ej: XXL"
            value={nombre}
            onChange={(event) => setNombre(event.currentTarget.value)}
            disabled={submitting}
            data-autofocus
          />
          <NumberInput
            label="Orden"
            description="Dónde aparece en la lista (S, M, L, XL…), no alfabético"
            min={0}
            step={1}
            value={orden}
            onChange={(value) =>
              setOrden(typeof value === 'number' ? value : '')
            }
            disabled={submitting}
          />
          <Text size="xs" c="dimmed">
            Se sugiere {ordenSugerido} (después del último talle) — cambialo si
            tenés que insertarlo en el medio.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Crear
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
