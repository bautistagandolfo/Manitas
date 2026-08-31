import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../lib/http-client';
import { parseNumberInputValue } from '../../lib/number-input';
import { createColor, createVariant, getColors, getSizes } from './api';
import type { Size, Color } from './types';
import { NuevoValorModal } from './components/NuevoValorModal';
import { NuevoTalleModal } from './components/NuevoTalleModal';

interface FormValues {
  sizeId: number | undefined;
  colorId: number | undefined;
  sku: string;
  barcode: string;
  precioVenta: number | '';
  costoActual: number | '';
}

// OWNER-only (AMB-11, RESUELTA) — la ruta ya está gateada por
// RequireOwner. Para productos sin variación de talle/color (cinturones,
// carteras — BLUEPRINT §3.3) o para agregar una variante suelta a un
// producto que ya tiene otras por grilla.
export function NewVariantPage() {
  const { productId } = useParams<{ productId: string }>();
  const id = Number(productId);
  const navigate = useNavigate();

  const [sizes, setSizes] = useState<Size[]>([]);
  const [colors, setColors] = useState<Color[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nuevoTalleOpen, setNuevoTalleOpen] = useState(false);
  const [nuevoColorOpen, setNuevoColorOpen] = useState(false);

  const form = useForm<FormValues>({
    initialValues: {
      sizeId: undefined,
      colorId: undefined,
      sku: '',
      barcode: '',
      precioVenta: '',
      costoActual: '',
    },
    validate: {
      precioVenta: (value) =>
        typeof value === 'number' && value > 0
          ? null
          : 'Tiene que ser mayor a 0',
      costoActual: (value) =>
        typeof value === 'number' && value > 0
          ? null
          : 'Tiene que ser mayor a 0',
    },
  });

  function loadSizes(selectId?: number): void {
    getSizes()
      .then((data) => {
        setSizes(data.filter((s) => s.activo));
        if (selectId !== undefined) {
          form.setFieldValue('sizeId', selectId);
        }
      })
      .catch(() => undefined);
  }

  function loadColors(selectId?: number): void {
    getColors()
      .then((data) => {
        setColors(data.filter((c) => c.activo));
        if (selectId !== undefined) {
          form.setFieldValue('colorId', selectId);
        }
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    loadSizes();
    loadColors();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSubmit = form.onSubmit(async (values) => {
    if (
      typeof values.precioVenta !== 'number' ||
      typeof values.costoActual !== 'number'
    ) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await createVariant(id, {
        sizeId: values.sizeId,
        colorId: values.colorId,
        sku: values.sku.trim() || undefined,
        barcode: values.barcode.trim() || undefined,
        precioVenta: values.precioVenta.toFixed(2),
        costoActual: values.costoActual.toFixed(2),
      });
      void navigate(`/catalogo/productos/${id}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo crear la variante. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Stack maw={480}>
      <Title order={3}>Nueva variante suelta</Title>
      <Paper withBorder p="md">
        <form onSubmit={handleSubmit}>
          <Stack>
            {error && (
              <Alert color="red" title="No se pudo crear">
                {error}
              </Alert>
            )}
            <Group align="flex-end" gap="xs">
              <Select
                label="Talle"
                placeholder="Sin talle"
                clearable
                disabled={submitting}
                data={sizes.map((s) => ({
                  value: String(s.id),
                  label: s.nombre,
                }))}
                value={
                  form.values.sizeId !== undefined
                    ? String(form.values.sizeId)
                    : null
                }
                onChange={(value) =>
                  form.setFieldValue(
                    'sizeId',
                    value ? Number(value) : undefined,
                  )
                }
                flex={1}
              />
              <Button
                variant="default"
                onClick={() => setNuevoTalleOpen(true)}
                disabled={submitting}
              >
                + Nuevo
              </Button>
            </Group>
            <Group align="flex-end" gap="xs">
              <Select
                label="Color"
                placeholder="Sin color"
                clearable
                disabled={submitting}
                data={colors.map((c) => ({
                  value: String(c.id),
                  label: c.nombre,
                }))}
                value={
                  form.values.colorId !== undefined
                    ? String(form.values.colorId)
                    : null
                }
                onChange={(value) =>
                  form.setFieldValue(
                    'colorId',
                    value ? Number(value) : undefined,
                  )
                }
                flex={1}
              />
              <Button
                variant="default"
                onClick={() => setNuevoColorOpen(true)}
                disabled={submitting}
              >
                + Nuevo
              </Button>
            </Group>
            <TextInput
              label="SKU"
              placeholder="Se genera automáticamente si lo dejás vacío"
              disabled={submitting}
              {...form.getInputProps('sku')}
            />
            <TextInput
              label="Código de barras"
              placeholder="Opcional"
              disabled={submitting}
              {...form.getInputProps('barcode')}
            />
            <NumberInput
              label="Precio de venta"
              withAsterisk
              decimalScale={2}
              fixedDecimalScale
              decimalSeparator=","
              thousandSeparator="."
              min={0.01}
              step={1}
              prefix="$ "
              disabled={submitting}
              value={form.values.precioVenta}
              onChange={(value) =>
                form.setFieldValue('precioVenta', parseNumberInputValue(value))
              }
              error={form.errors.precioVenta}
            />
            <NumberInput
              label="Costo"
              withAsterisk
              decimalScale={2}
              fixedDecimalScale
              decimalSeparator=","
              thousandSeparator="."
              min={0.01}
              step={1}
              prefix="$ "
              disabled={submitting}
              value={form.values.costoActual}
              onChange={(value) =>
                form.setFieldValue('costoActual', parseNumberInputValue(value))
              }
              error={form.errors.costoActual}
            />
            <Group justify="flex-end">
              <Button type="submit" loading={submitting}>
                Crear variante
              </Button>
            </Group>
          </Stack>
        </form>
      </Paper>

      {nuevoTalleOpen && (
        <NuevoTalleModal
          ordenSugerido={
            sizes.length > 0 ? Math.max(...sizes.map((s) => s.orden)) + 1 : 1
          }
          onClose={() => setNuevoTalleOpen(false)}
          onCreated={(size) => {
            setNuevoTalleOpen(false);
            loadSizes(size.id);
          }}
        />
      )}

      {nuevoColorOpen && (
        <NuevoValorModal
          title="Nuevo color"
          label="Nombre"
          placeholder="Ej: Bordó"
          onCreate={createColor}
          onClose={() => setNuevoColorOpen(false)}
          onCreated={(color) => {
            setNuevoColorOpen(false);
            loadColors(color.id);
          }}
        />
      )}
    </Stack>
  );
}
