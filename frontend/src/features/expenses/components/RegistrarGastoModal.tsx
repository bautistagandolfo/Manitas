import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';
import { ApiError } from '../../../lib/http-client';
import { parseNumberInputValue } from '../../../lib/number-input';
import { useIdempotencyKey } from '../../../lib/idempotency';
import { getExpenseCategories, registrarGasto } from '../api';
import type { Expense, ExpenseCategory, ExpenseMedioPago } from '../types';
import { NuevaCategoriaModal } from './NuevaCategoriaModal';

interface RegistrarGastoModalProps {
  onClose: () => void;
  onSaved: (gasto: Expense) => void;
}

const MEDIO_PAGO_OPTIONS: { value: ExpenseMedioPago; label: string }[] = [
  { value: 'EFECTIVO', label: 'Efectivo' },
  { value: 'TRANSFERENCIA', label: 'Transferencia' },
  { value: 'OTRO', label: 'Otro' },
];

// RN-2, RN-4, RN-6, RN-7 (T6.2/T6.3) — un solo medio de pago (no una
// lista, a diferencia de una venta). Si es EFECTIVO, el backend exige una
// sesión de caja abierta (409 si no la hay) y genera el movimiento
// vinculado; TRANSFERENCIA/OTRO no la necesitan ("la dueña puede pagar el
// alquiler un domingo desde su casa", BLUEPRINT invariante 10) — esta
// pantalla no duplica esa regla, solo deja pasar el error del backend tal
// cual si no hay caja abierta.
export function RegistrarGastoModal({
  onClose,
  onSaved,
}: RegistrarGastoModalProps) {
  const [categorias, setCategorias] = useState<ExpenseCategory[] | null>(null);
  const [categoriasError, setCategoriasError] = useState<string | null>(null);
  const [nuevaCategoriaOpen, setNuevaCategoriaOpen] = useState(false);

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [descripcion, setDescripcion] = useState('');
  const [monto, setMonto] = useState<number | ''>('');
  const [medioPago, setMedioPago] = useState<ExpenseMedioPago>('EFECTIVO');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { key: idempotencyKey, rotate } = useIdempotencyKey(
    'expenses:registrar-gasto-idempotency-key',
  );

  function loadCategorias(selectAfter?: number): void {
    getExpenseCategories()
      .then((data) => {
        setCategorias(data);
        setCategoriasError(null);
        if (selectAfter) setCategoryId(String(selectAfter));
      })
      .catch((err: unknown) => {
        setCategoriasError(
          err instanceof ApiError
            ? err.message
            : 'No se pudieron cargar las categorías.',
        );
      });
  }

  useEffect(() => {
    loadCategorias();
  }, []);

  const categoriaOptions = (categorias ?? [])
    .filter((c) => c.activo)
    .map((c) => ({ value: String(c.id), label: c.nombre }));

  async function handleSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!categoryId) {
      setError('Elegí una categoría');
      return;
    }
    if (typeof monto !== 'number' || monto <= 0) {
      setError('Ingresá un monto mayor a 0');
      return;
    }
    if (!descripcion.trim()) {
      setError('Ingresá una descripción');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const gasto = await registrarGasto(
        {
          expenseCategoryId: Number(categoryId),
          descripcion: descripcion.trim(),
          monto: monto.toFixed(2),
          medioPago,
        },
        idempotencyKey,
      );
      rotate();
      onSaved(gasto);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar el gasto. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title="Registrar gasto">
      <form onSubmit={(event) => void handleSubmit(event)}>
        <Stack>
          {error && (
            <Alert color="red" title="No se pudo registrar">
              {error}
            </Alert>
          )}
          {categoriasError && (
            <Alert color="red" title="No se pudieron cargar las categorías">
              {categoriasError}
            </Alert>
          )}

          <Group align="flex-end" gap="xs">
            <Select
              label="Categoría"
              placeholder="Elegí una categoría"
              data={categoriaOptions}
              value={categoryId}
              onChange={setCategoryId}
              disabled={submitting || !categorias}
              searchable
              flex={1}
            />
            <Button
              variant="default"
              onClick={() => setNuevaCategoriaOpen(true)}
              disabled={submitting}
            >
              + Nueva
            </Button>
          </Group>

          <Textarea
            label="Descripción"
            placeholder="Para qué es este gasto"
            value={descripcion}
            onChange={(event) => setDescripcion(event.currentTarget.value)}
            disabled={submitting}
            autosize
            minRows={2}
          />

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
            value={monto}
            onChange={(value) => setMonto(parseNumberInputValue(value))}
          />

          <Select
            label="Medio de pago"
            data={MEDIO_PAGO_OPTIONS}
            value={medioPago}
            onChange={(value) => setMedioPago(value ?? 'EFECTIVO')}
            allowDeselect={false}
            disabled={submitting}
          />
          {medioPago === 'EFECTIVO' && (
            <Text size="xs" c="dimmed">
              Necesita una sesión de caja abierta — se descuenta del cajón.
            </Text>
          )}

          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancelar
            </Button>
            <Button type="submit" loading={submitting} disabled={submitting}>
              Registrar gasto
            </Button>
          </Group>
        </Stack>
      </form>

      {nuevaCategoriaOpen && (
        <NuevaCategoriaModal
          onClose={() => setNuevaCategoriaOpen(false)}
          onCreated={(categoria) => {
            setNuevaCategoriaOpen(false);
            loadCategorias(categoria.id);
          }}
        />
      )}
    </Modal>
  );
}
