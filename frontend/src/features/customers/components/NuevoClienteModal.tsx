import { useState } from 'react';
import { Alert, Button, Group, Modal, Stack, TextInput } from '@mantine/core';
import { ApiError } from '../../../lib/http-client';
import { crearCliente } from '../api';
import type { Customer } from '../types';

interface NuevoClienteModalProps {
  // Precarga el campo Nombre con lo que ya se haya tipeado en el buscador
  // (mismo criterio que `NuevoValorModal` — no hacer escribir dos veces
  // lo mismo).
  nombreInicial?: string;
  onClose: () => void;
  onCreated: (cliente: Customer) => void;
}

// Ticket nuevo (post Release Candidate, BLUEPRINT §8.4) — alta rápida de
// cliente (mismo patrón que `NuevaCategoriaModal`/`NuevoValorModal`). El
// DNI es obligatorio: es lo que distingue de forma inequívoca (puede
// haber dos "Carlos Martínez", pedido explícito del usuario) — el
// backend valida formato y unicidad; acá solo se muestra el mensaje tal
// como llega.
export function NuevoClienteModal({
  nombreInicial = '',
  onClose,
  onCreated,
}: NuevoClienteModalProps) {
  const [nombre, setNombre] = useState(nombreInicial);
  const [dni, setDni] = useState('');
  const [telefono, setTelefono] = useState('');
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
      const cliente = await crearCliente({
        nombre: nombre.trim(),
        dni: dni.trim(),
        telefono: telefono.trim() || undefined,
      });
      onCreated(cliente);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo crear el cliente. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Nuevo cliente">
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
            placeholder="Ej: Carlos Martínez"
            value={nombre}
            onChange={(event) => setNombre(event.currentTarget.value)}
            disabled={submitting}
            data-autofocus
          />
          <TextInput
            label="DNI"
            withAsterisk
            description="Distingue clientes con el mismo nombre"
            placeholder="Ej: 30123456"
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
              Crear
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
