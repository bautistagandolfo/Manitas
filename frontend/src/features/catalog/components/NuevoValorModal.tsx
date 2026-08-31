import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { ApiError } from '../../../lib/http-client';

interface NuevoValorEntity {
  id: number;
  nombre: string;
}

interface NuevoValorModalProps {
  title: string;
  label: string;
  placeholder?: string;
  onCreate: (nombre: string) => Promise<NuevoValorEntity>;
  onClose: () => void;
  onCreated: (entity: NuevoValorEntity) => void;
}

// Ticket nuevo (post Release Candidate) — hallazgo real de uso: marca,
// categoría y color solo se podían ELEGIR desde sus combos (GET
// /brands|/categories|/colors), nunca crear — ninguno de los tres POST
// del backend tiene @Roles(), la ausencia era pura falta de UI. Un
// modal genérico para los tres (mismo shape exacto, {nombre} →
// {id, nombre}) — talle queda aparte (`NuevoTalleModal.tsx`) porque
// necesita un campo más (`orden`). Mismo patrón ya probado en
// `expenses/components/NuevaCategoriaModal.tsx`.
export function NuevoValorModal({
  title,
  label,
  placeholder,
  onCreate,
  onClose,
  onCreated,
}: NuevoValorModalProps) {
  const [nombre, setNombre] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = nombre.trim();
    if (!trimmed) {
      setError('Ingresá un nombre');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const entity = await onCreate(trimmed);
      onCreated(entity);
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
    <Modal opened onClose={onClose} title={title}>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo crear">
              {error}
            </Alert>
          )}
          <TextInput
            label={label}
            withAsterisk
            placeholder={placeholder}
            value={nombre}
            onChange={(event) => setNombre(event.currentTarget.value)}
            disabled={submitting}
            data-autofocus
          />
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
