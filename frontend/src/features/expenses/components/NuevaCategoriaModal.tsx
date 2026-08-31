import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { ApiError } from '../../../lib/http-client';
import { createExpenseCategory } from '../api';
import type { ExpenseCategory } from '../types';

interface NuevaCategoriaModalProps {
  onClose: () => void;
  onCreated: (categoria: ExpenseCategory) => void;
}

// T6.1/T6.8 — alta rápida de categoría de gasto desde el propio
// formulario de registro (RN-1: cualquier rol autenticado puede crearlas,
// pero esta pantalla entera ya vive detrás de `RequireOwner`). AD-7 lo
// valida el backend (400 si el nombre alude a mercadería) — acá solo se
// muestra el mensaje tal como llega, sin duplicar la regla.
export function NuevaCategoriaModal({
  onClose,
  onCreated,
}: NuevaCategoriaModalProps) {
  const [nombre, setNombre] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = nombre.trim();
    if (!trimmed) {
      setError('Ingresá un nombre');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const categoria = await createExpenseCategory(trimmed);
      onCreated(categoria);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo crear la categoría. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Nueva categoría de gasto">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo crear">
              {error}
            </Alert>
          )}
          <TextInput
            label="Nombre"
            withAsterisk
            placeholder="Ej: Insumos de limpieza"
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
