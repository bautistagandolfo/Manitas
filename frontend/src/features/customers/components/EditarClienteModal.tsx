import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { ApiError } from '../../../lib/http-client';
import { actualizarCliente } from '../api';
import type { Customer } from '../types';

interface EditarClienteModalProps {
  cliente: Customer;
  onClose: () => void;
  onUpdated: (cliente: Customer) => void;
}

// Ticket nuevo (post Release Candidate) — pedido directo del usuario:
// "editar... por si pusimos mal datos". Mismos campos y mismas
// validaciones que `NuevoClienteModal` (reusa `actualizarCliente`, PATCH
// parcial), pero sin el toggle de activo — dar de baja/reactivar es una
// acción aparte y más deliberada en `ClientesPage`, no algo que se cuele
// al guardar una corrección de nombre.
export function EditarClienteModal({
  cliente,
  onClose,
  onUpdated,
}: EditarClienteModalProps) {
  const [nombre, setNombre] = useState(cliente.nombre);
  const [dni, setDni] = useState(cliente.dni);
  const [telefono, setTelefono] = useState(cliente.telefono ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!nombre.trim()) {
      setError('Ingresá un nombre');
      return;
    }
    if (!dni.trim()) {
      setError('Ingresá el DNI');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const actualizado = await actualizarCliente(cliente.id, {
        nombre: nombre.trim(),
        dni: dni.trim(),
        telefono: telefono.trim(),
      });
      onUpdated(actualizado);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo guardar el cambio. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Editar cliente">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo guardar">
              {error}
            </Alert>
          )}
          <TextInput
            label="Nombre"
            withAsterisk
            value={nombre}
            onChange={(event) => setNombre(event.currentTarget.value)}
            disabled={submitting}
            data-autofocus
          />
          <TextInput
            label="DNI"
            withAsterisk
            description="Distingue clientes con el mismo nombre"
            value={dni}
            onChange={(event) => setDni(event.currentTarget.value)}
            disabled={submitting}
          />
          <TextInput
            label="Teléfono"
            placeholder="Opcional"
            value={telefono}
            onChange={(event) => setTelefono(event.currentTarget.value)}
            disabled={submitting}
          />
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Guardar cambios
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
