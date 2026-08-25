import { useState } from 'react';
import {
  Button,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { parseNumberInputValue } from '../../../lib/number-input';
import type { DraftDiscount } from '../cart';

interface DiscountModalProps {
  onClose: () => void;
  onAdd: (discount: DraftDiscount) => void;
}

type Modo = 'PORCENTAJE' | 'MONTO';

interface FormValues {
  descripcion: string;
  modo: Modo;
  porcentaje: number | '';
  monto: number | '';
}

// Atajo `F4` (BLUEPRINT §12.1). Mutuamente excluyentes (`porcentaje` o
// `monto`, nunca los dos — mismo contrato que `CrearVentaDiscountInput`
// del backend, T4.3): acá se elige el modo con un `SegmentedControl` en
// vez de mostrar los dos campos a la vez. Sin tope de vendedor ni
// autorización de OWNER acá — esta pantalla solo arma el borrador, la
// validación real (RN-4, invariante 4) la hace `crearVenta` al confirmar
// la venta (T4.11).
export function DiscountModal({ onClose, onAdd }: DiscountModalProps) {
  const [submitted, setSubmitted] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      descripcion: '',
      modo: 'PORCENTAJE',
      porcentaje: '',
      monto: '',
    },
    validate: {
      descripcion: (value) =>
        value.trim().length > 0 ? null : 'Ingresá una descripción',
      porcentaje: (value, values) =>
        values.modo === 'PORCENTAJE' &&
        (typeof value !== 'number' || value <= 0)
          ? 'Tiene que ser mayor a 0'
          : null,
      monto: (value, values) =>
        values.modo === 'MONTO' && (typeof value !== 'number' || value <= 0)
          ? 'Tiene que ser mayor a 0'
          : null,
    },
  });

  const handleSubmit = form.onSubmit((values) => {
    setSubmitted(true);
    onAdd({
      id: crypto.randomUUID(),
      descripcion: values.descripcion.trim(),
      ...(values.modo === 'PORCENTAJE'
        ? { porcentaje: String(values.porcentaje) }
        : { monto: String(values.monto).replace(',', '.') }),
    });
  });

  return (
    <Modal opened onClose={onClose} title="Aplicar descuento (F4)">
      <form onSubmit={handleSubmit}>
        <Stack>
          <TextInput
            label="Descripción"
            placeholder="Motivo del descuento"
            disabled={submitted}
            {...form.getInputProps('descripcion')}
          />
          <SegmentedControl
            value={form.values.modo}
            onChange={(value) => form.setFieldValue('modo', value)}
            disabled={submitted}
            data={[
              { label: 'Porcentaje', value: 'PORCENTAJE' },
              { label: 'Monto fijo', value: 'MONTO' },
            ]}
          />
          {form.values.modo === 'PORCENTAJE' ? (
            <NumberInput
              label="Porcentaje"
              suffix=" %"
              min={0.01}
              max={100}
              decimalScale={2}
              disabled={submitted}
              value={form.values.porcentaje}
              onChange={(value) =>
                form.setFieldValue('porcentaje', parseNumberInputValue(value))
              }
              error={form.errors.porcentaje}
            />
          ) : (
            <NumberInput
              label="Monto"
              decimalScale={2}
              fixedDecimalScale
              decimalSeparator=","
              thousandSeparator="."
              min={0.01}
              prefix="$ "
              disabled={submitted}
              value={form.values.monto}
              onChange={(value) =>
                form.setFieldValue('monto', parseNumberInputValue(value))
              }
              error={form.errors.monto}
            />
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitted}>
              Cancelar
            </Button>
            <Button type="submit" disabled={submitted}>
              Aplicar descuento
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
