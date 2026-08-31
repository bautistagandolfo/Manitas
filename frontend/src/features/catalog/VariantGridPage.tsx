import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Divider,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../lib/http-client';
import { parseNumberInputValue } from '../../lib/number-input';
import { createColor, createVariantGrid, getColors, getSizes } from './api';
import { applyDefaultsToAllRows, buildGridRows } from './grid';
import type { GridRow } from './grid';
import type { Size, Color } from './types';
import { NuevoValorModal } from './components/NuevoValorModal';
import { NuevoTalleModal } from './components/NuevoTalleModal';

// BLUEPRINT §12.3: separador de miles con punto, decimal con coma —
// mismos props en todo NumberInput de dinero de esta pantalla.
const MONEY_PROPS = {
  decimalScale: 2,
  fixedDecimalScale: true,
  decimalSeparator: ',',
  thousandSeparator: '.',
  min: 0,
  step: 1,
  prefix: '$ ',
} as const;

// RN-8/§12.2 — OWNER-only (ruta ya gateada por RequireOwner). Flujo: 1)
// elegir talles y colores, 2) generar la grilla (producto cartesiano),
// 3) completar stock/precio/costo por fila, con la opción de aplicar los
// mismos valores a todas de una vez, 4) confirmar.
export function VariantGridPage() {
  const { productId } = useParams<{ productId: string }>();
  const id = Number(productId);
  const navigate = useNavigate();

  const [sizes, setSizes] = useState<Size[]>([]);
  const [colors, setColors] = useState<Color[]>([]);
  const [selectedSizeIds, setSelectedSizeIds] = useState<string[]>([]);
  const [selectedColorIds, setSelectedColorIds] = useState<string[]>([]);
  const [rows, setRows] = useState<GridRow[]>([]);

  const [defaultStock, setDefaultStock] = useState<number | ''>('');
  const [defaultPrecio, setDefaultPrecio] = useState<number | ''>('');
  const [defaultCosto, setDefaultCosto] = useState<number | ''>('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nuevoTalleOpen, setNuevoTalleOpen] = useState(false);
  const [nuevoColorOpen, setNuevoColorOpen] = useState(false);

  // `addId`, si viene, además de recargar la lista, agrega el nuevo
  // talle/color a la selección — se acaba de crear porque hacía falta
  // usarlo ahora, no solo para que quede disponible más adelante.
  function loadSizes(addId?: number): void {
    getSizes()
      .then((data) => {
        setSizes(data.filter((s) => s.activo));
        if (addId !== undefined) {
          setSelectedSizeIds((prev) => [...prev, String(addId)]);
        }
      })
      .catch(() => undefined);
  }

  function loadColors(addId?: number): void {
    getColors()
      .then((data) => {
        setColors(data.filter((c) => c.activo));
        if (addId !== undefined) {
          setSelectedColorIds((prev) => [...prev, String(addId)]);
        }
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    loadSizes();
    loadColors();
  }, []);

  const sizeById = new Map(sizes.map((s) => [s.id, s]));
  const colorById = new Map(colors.map((c) => [c.id, c]));

  const handleGenerar = (): void => {
    const sizeIds = selectedSizeIds.map(Number);
    const colorIds = selectedColorIds.map(Number);
    // Ticket nuevo (post Release Candidate) — hallazgo real: sin pasar
    // `rows` (el estado actual) como `existingRows`, volver a generar
    // después de agregar un talle/color más pisaba en silencio todo lo
    // ya cargado a mano en las filas existentes. Ver el comentario de
    // `buildGridRows` en `grid.ts`.
    setRows((prev) =>
      buildGridRows(
        sizeIds,
        colorIds,
        {
          stock: defaultStock || 0,
          precioVenta: defaultPrecio ? defaultPrecio.toFixed(2) : '0.00',
          costo: defaultCosto ? defaultCosto.toFixed(2) : '0.00',
        },
        prev,
      ),
    );
  };

  const handleAplicarATodas = (): void => {
    setRows((prev) =>
      applyDefaultsToAllRows(prev, {
        stock: defaultStock || 0,
        precioVenta: defaultPrecio ? defaultPrecio.toFixed(2) : '0.00',
        costo: defaultCosto ? defaultCosto.toFixed(2) : '0.00',
      }),
    );
  };

  const updateRow = (index: number, patch: Partial<GridRow>): void => {
    setRows((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    const rowsInvalidas = rows.some(
      (row) => !(Number(row.precioVenta) > 0) || !(Number(row.costo) > 0),
    );
    if (rowsInvalidas) {
      setError('Precio y costo tienen que ser mayores a 0 en todas las filas.');
      return;
    }

    setSubmitting(true);
    try {
      const created = await createVariantGrid(id, {
        sizeIds: selectedSizeIds.map(Number),
        colorIds: selectedColorIds.map(Number),
        filas: rows.map((row) => ({
          sizeId: row.sizeId,
          colorId: row.colorId,
          sku: row.sku.trim() || undefined,
          stock: row.stock,
          precioVenta: row.precioVenta,
          costo: row.costo,
        })),
      });
      notifications.show({
        color: 'green',
        title: 'Variantes creadas',
        message: `Se crearon ${created.length} variantes.`,
      });
      void navigate(`/catalogo/productos/${id}`);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo cargar la grilla. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Stack>
      <Title order={3}>Cargar variantes por grilla</Title>

      <Paper withBorder p="md">
        <Stack>
          <Group grow align="flex-end">
            <Group align="flex-end" gap="xs" flex={1}>
              <MultiSelect
                label="Talles"
                withAsterisk
                placeholder="Elegí uno o más"
                data={sizes.map((s) => ({
                  value: String(s.id),
                  label: s.nombre,
                }))}
                value={selectedSizeIds}
                onChange={setSelectedSizeIds}
                flex={1}
              />
              <Button variant="default" onClick={() => setNuevoTalleOpen(true)}>
                + Nuevo
              </Button>
            </Group>
            <Group align="flex-end" gap="xs" flex={1}>
              <MultiSelect
                label="Colores"
                withAsterisk
                placeholder="Elegí uno o más"
                data={colors.map((c) => ({
                  value: String(c.id),
                  label: c.nombre,
                }))}
                value={selectedColorIds}
                onChange={setSelectedColorIds}
                flex={1}
              />
              <Button variant="default" onClick={() => setNuevoColorOpen(true)}>
                + Nuevo
              </Button>
            </Group>
          </Group>
          <Button
            onClick={handleGenerar}
            disabled={
              selectedSizeIds.length === 0 || selectedColorIds.length === 0
            }
            w="fit-content"
          >
            Generar grilla
          </Button>
        </Stack>
      </Paper>

      {rows.length > 0 && (
        <Paper withBorder p="md">
          <Stack>
            <Text fw={500}>Aplicar a todas las filas</Text>
            <Group grow align="flex-end">
              <NumberInput
                label="Stock"
                min={0}
                step={1}
                value={defaultStock}
                onChange={(value) =>
                  setDefaultStock(parseNumberInputValue(value))
                }
              />
              <NumberInput
                label="Precio"
                {...MONEY_PROPS}
                value={defaultPrecio}
                onChange={(value) =>
                  setDefaultPrecio(parseNumberInputValue(value))
                }
              />
              <NumberInput
                label="Costo"
                {...MONEY_PROPS}
                value={defaultCosto}
                onChange={(value) =>
                  setDefaultCosto(parseNumberInputValue(value))
                }
              />
              <Button variant="default" onClick={handleAplicarATodas}>
                Aplicar a todas
              </Button>
            </Group>
          </Stack>

          <Divider my="md" />

          {error && (
            <Alert color="red" title="No se pudo cargar la grilla" mb="md">
              {error}
            </Alert>
          )}

          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Talle</Table.Th>
                <Table.Th>Color</Table.Th>
                <Table.Th>SKU</Table.Th>
                <Table.Th>Stock</Table.Th>
                <Table.Th>Precio</Table.Th>
                <Table.Th>Costo</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((row, index) => (
                <Table.Tr key={`${row.sizeId}-${row.colorId}`}>
                  <Table.Td>
                    {sizeById.get(row.sizeId)?.nombre ?? row.sizeId}
                  </Table.Td>
                  <Table.Td>
                    {colorById.get(row.colorId)?.nombre ?? row.colorId}
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      placeholder="Auto"
                      value={row.sku}
                      onChange={(event) =>
                        updateRow(index, { sku: event.currentTarget.value })
                      }
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      min={0}
                      step={1}
                      value={row.stock}
                      onChange={(value) => {
                        const parsed = parseNumberInputValue(value);
                        updateRow(index, { stock: parsed === '' ? 0 : parsed });
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      {...MONEY_PROPS}
                      value={Number(row.precioVenta)}
                      onChange={(value) => {
                        const parsed = parseNumberInputValue(value);
                        updateRow(index, {
                          precioVenta:
                            parsed === '' ? '0.00' : parsed.toFixed(2),
                        });
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <NumberInput
                      {...MONEY_PROPS}
                      value={Number(row.costo)}
                      onChange={(value) => {
                        const parsed = parseNumberInputValue(value);
                        updateRow(index, {
                          costo: parsed === '' ? '0.00' : parsed.toFixed(2),
                        });
                      }}
                    />
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Group justify="flex-end" mt="md">
            <Button
              variant="default"
              onClick={() => void navigate(`/catalogo/productos/${id}`)}
            >
              Cancelar
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              loading={submitting}
              disabled={submitting}
            >
              Crear {rows.length} variantes
            </Button>
          </Group>
        </Paper>
      )}

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
