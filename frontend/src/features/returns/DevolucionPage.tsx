import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  Loader,
  NumberInput,
  Radio,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { ApiError } from '../../lib/http-client';
import { formatCurrency, formatDate } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useAuth } from '../auth/AuthContext';
import { searchVariants } from '../catalog/api';
import type { VariantSearchResult } from '../catalog/types';
import { buscarVentaParaDevolucion, crearDevolucion } from './api';
import type {
  PaymentMetodo,
  SaleReturnInfo,
  SaleReturnInfoItem,
} from './types';
import {
  centsToAmountString,
  creditoAplicadoCents,
  diferenciaACobrarCents,
  extraAReintegrarCents,
  lineNetoADevolverCents,
  saldoReintegroCents,
  toCents,
  totalADevolverCents,
  type DevolucionLineSelection,
  type DraftReintegro,
} from './calc';
import { PaymentLinesBuilder } from './components/PaymentLinesBuilder';

const IDEMPOTENCY_STORAGE_KEY = 'devolucion:idempotency-key';

interface NuevaPrendaLine {
  variantId: number;
  descripcion: string;
  precioVenta: string;
  cantidad: number;
}

function buildDescripcion(variant: VariantSearchResult): string {
  return [variant.product.nombre, variant.size?.nombre, variant.color?.nombre]
    .filter((parte): parte is string => Boolean(parte))
    .join(' - ');
}

// T5.7 (frontend, BLUEPRINT §5.4/AD-17/AD-18) — pantalla de devolución y
// cambio: busca una venta por número (`GET /returns/sales/:numero`, T5.7
// backend), deja elegir qué líneas devolver y en qué cantidad, y arma
// `POST /returns` como devolución simple o como cambio (con una venta
// nueva ligada, crédito por medio, RN-9/AMB-16). El monto exacto que
// reconoce cada línea lo calcula el backend (AD-18) — acá se
// PREVISUALIZA con la misma fórmula (`calc.ts`) para poder armar los
// reintegros/pagos que tienen que sumar ese total antes de enviar; el
// backend vuelve a validar todo al confirmar, esta pantalla nunca es la
// última palabra.
//
// Sin persistencia de borrador en `sessionStorage` (a diferencia de
// `SalePage`/`CobroPage`): un F5 a mitad de una devolución simplemente
// pierde la selección en curso y hay que volver a buscar la venta — una
// pérdida de conveniencia, no de integridad (nada se envía hasta
// confirmar). La clave de idempotencia sí persiste (mismo mecanismo que
// `sales`, `lib/idempotency.ts`), así que un reenvío tras un F5 durante
// el propio submit nunca duplica la devolución.
export function DevolucionPage() {
  const { user } = useAuth();
  const { key: idempotencyKey, rotate: rotateIdempotencyKey } =
    useIdempotencyKey(IDEMPOTENCY_STORAGE_KEY);

  const [numeroQuery, setNumeroQuery] = useState('');
  const [saleInfo, setSaleInfo] = useState<SaleReturnInfo | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const [selections, setSelections] = useState<
    Record<number, DevolucionLineSelection>
  >({});
  const [tipo, setTipo] = useState<'DEVOLUCION' | 'CAMBIO'>('DEVOLUCION');
  const [reintegroLines, setReintegroLines] = useState<DraftReintegro[]>([]);

  const [nuevaQuery, setNuevaQuery] = useState('');
  const [debouncedNuevaQuery] = useDebouncedValue(nuevaQuery, 200);
  const [nuevaResults, setNuevaResults] = useState<
    VariantSearchResult[] | null
  >(null);
  const [nuevaItems, setNuevaItems] = useState<NuevaPrendaLine[]>([]);
  const [diferenciaLines, setDiferenciaLines] = useState<DraftReintegro[]>([]);
  const [extraReintegroLines, setExtraReintegroLines] = useState<
    DraftReintegro[]
  >([]);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Mismo patrón que `SalePage.tsx`: cuando el término de búsqueda queda
  // vacío, se limpia el resultado anterior durante el render (no dentro
  // del efecto de abajo, que dispararía `react-hooks/set-state-in-effect`).
  const [trackedNuevaQuery, setTrackedNuevaQuery] =
    useState(debouncedNuevaQuery);
  if (debouncedNuevaQuery !== trackedNuevaQuery) {
    setTrackedNuevaQuery(debouncedNuevaQuery);
    if (!debouncedNuevaQuery.trim()) {
      setNuevaResults(null);
    }
  }

  useEffect(() => {
    const trimmed = debouncedNuevaQuery.trim();
    if (!trimmed) return;
    let cancelled = false;
    searchVariants({ q: trimmed, pageSize: 8 })
      .then((data) => {
        if (!cancelled) setNuevaResults(data.items);
      })
      .catch(() => {
        if (!cancelled) setNuevaResults(null);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedNuevaQuery]);

  function resetFormAfterSubmit(): void {
    setSaleInfo(null);
    setNumeroQuery('');
    setSelections({});
    setTipo('DEVOLUCION');
    setReintegroLines([]);
    setNuevaItems([]);
    setNuevaQuery('');
    setNuevaResults(null);
    setDiferenciaLines([]);
    setExtraReintegroLines([]);
    setSubmitError(null);
  }

  async function handleBuscar(): Promise<void> {
    const numero = Number(numeroQuery.trim());
    if (!numeroQuery.trim() || !Number.isInteger(numero) || numero <= 0) {
      setSearchError('Ingresá un número de venta válido');
      return;
    }
    setSearchLoading(true);
    setSearchError(null);
    try {
      const info = await buscarVentaParaDevolucion(numero);
      setSaleInfo(info);
      setSelections({});
      setReintegroLines([]);
      setNuevaItems([]);
      setDiferenciaLines([]);
      setExtraReintegroLines([]);
      setTipo('DEVOLUCION');
    } catch (err) {
      setSaleInfo(null);
      setSearchError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo buscar la venta. Probá de nuevo.',
      );
    } finally {
      setSearchLoading(false);
    }
  }

  function handleBuscarKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleBuscar();
    }
  }

  function setLineCantidad(item: SaleReturnInfoItem, cantidad: number): void {
    setSelections((prev) => {
      if (cantidad <= 0) {
        const next = { ...prev };
        delete next[item.saleItemId];
        return next;
      }
      const clamped = Math.min(cantidad, item.cantidadDisponible);
      return {
        ...prev,
        [item.saleItemId]: {
          saleItemId: item.saleItemId,
          cantidad: clamped,
          reingresaStock: prev[item.saleItemId]?.reingresaStock ?? true,
        },
      };
    });
  }

  function setLineReingresaStock(saleItemId: number, value: boolean): void {
    setSelections((prev) => {
      const existing = prev[saleItemId];
      if (!existing) return prev;
      return {
        ...prev,
        [saleItemId]: { ...existing, reingresaStock: value },
      };
    });
  }

  const selectionList = Object.values(selections);
  const totalCents = saleInfo
    ? totalADevolverCents(saleInfo.items, selectionList)
    : 0;

  function addNuevaVariant(variant: VariantSearchResult): void {
    setNuevaItems((prev) => {
      const index = prev.findIndex((l) => l.variantId === variant.id);
      if (index === -1) {
        return [
          ...prev,
          {
            variantId: variant.id,
            descripcion: buildDescripcion(variant),
            precioVenta: variant.precioVenta,
            cantidad: 1,
          },
        ];
      }
      const updated = [...prev];
      updated[index] = {
        ...updated[index],
        cantidad: updated[index].cantidad + 1,
      };
      return updated;
    });
    setNuevaQuery('');
    setNuevaResults(null);
  }

  function quitarNuevaItem(variantId: number): void {
    setNuevaItems((prev) => prev.filter((l) => l.variantId !== variantId));
  }

  const nuevaVentaTotalCents = nuevaItems.reduce(
    (sum, l) => sum + toCents(l.precioVenta) * l.cantidad,
    0,
  );
  const creditoCents =
    tipo === 'CAMBIO'
      ? creditoAplicadoCents(totalCents, nuevaVentaTotalCents)
      : 0;
  const diferenciaCents =
    tipo === 'CAMBIO'
      ? diferenciaACobrarCents(totalCents, nuevaVentaTotalCents)
      : 0;
  const extraCents =
    tipo === 'CAMBIO'
      ? extraAReintegrarCents(totalCents, nuevaVentaTotalCents)
      : 0;

  const puedeConfirmarDevolucion =
    tipo === 'DEVOLUCION' &&
    totalCents > 0 &&
    saldoReintegroCents(totalCents, reintegroLines) === 0;

  const puedeConfirmarCambio =
    tipo === 'CAMBIO' &&
    totalCents > 0 &&
    nuevaItems.length > 0 &&
    saldoReintegroCents(diferenciaCents, diferenciaLines) === 0 &&
    saldoReintegroCents(extraCents, extraReintegroLines) === 0;

  async function handleConfirmar(): Promise<void> {
    if (!saleInfo) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const items = selectionList.map((sel) => ({
        saleItemId: sel.saleItemId,
        cantidad: sel.cantidad,
        reingresaStock: sel.reingresaStock,
      }));

      if (tipo === 'DEVOLUCION') {
        const result = await crearDevolucion(
          {
            saleId: saleInfo.saleId,
            tipo: 'DEVOLUCION',
            items,
            returnPayments: reintegroLines.map((r) => ({
              metodo: r.metodo as PaymentMetodo,
              monto: r.monto,
            })),
          },
          idempotencyKey,
        );
        notifications.show({
          color: 'green',
          title: 'Devolución registrada',
          message: `Devolución #${result.numero} por ${formatCurrency(result.totalDevuelto)}`,
        });
      } else {
        const result = await crearDevolucion(
          {
            saleId: saleInfo.saleId,
            tipo: 'CAMBIO',
            items,
            returnPayments: [
              {
                metodo: 'CREDITO_DEVOLUCION',
                monto: centsToAmountString(creditoCents),
              },
              ...extraReintegroLines.map((r) => ({
                metodo: r.metodo as PaymentMetodo,
                monto: r.monto,
              })),
            ],
            ventaNueva: {
              items: nuevaItems.map((l) => ({
                variantId: l.variantId,
                cantidad: l.cantidad,
              })),
              payments: diferenciaLines.map((r) => ({
                metodo: r.metodo as PaymentMetodo,
                monto: r.monto,
              })),
            },
          },
          idempotencyKey,
        );
        notifications.show({
          color: 'green',
          title: 'Cambio registrado',
          message: `Devolución #${result.numero} — venta nueva vinculada`,
        });
      }

      rotateIdempotencyKey();
      resetFormAfterSubmit();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar la operación. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Stack>
      <Title order={3}>Devolución y cambio</Title>

      <Group align="flex-end">
        <TextInput
          label="Número de venta"
          placeholder="Ej: 1024"
          value={numeroQuery}
          onChange={(event) => setNumeroQuery(event.currentTarget.value)}
          onKeyDown={handleBuscarKeyDown}
          rightSection={searchLoading ? <Loader size="xs" /> : null}
          w={220}
        />
        <Button onClick={() => void handleBuscar()} loading={searchLoading}>
          Buscar
        </Button>
      </Group>

      {searchError && (
        <Alert color="red" title="No se pudo buscar">
          {searchError}
        </Alert>
      )}

      {saleInfo && (
        <>
          <Card withBorder>
            <Group justify="space-between">
              <Stack gap={0}>
                <Text fw={700}>Venta #{saleInfo.numero}</Text>
                <Text size="sm" c="dimmed">
                  {formatDate(saleInfo.fecha)} — {saleInfo.estado}
                </Text>
              </Stack>
              <Badge color={saleInfo.dentroDePlazo ? 'green' : 'orange'}>
                {saleInfo.dentroDePlazo
                  ? 'Dentro de plazo'
                  : 'Fuera de plazo — necesita autorización de un dueño'}
              </Badge>
            </Group>
          </Card>

          {!saleInfo.dentroDePlazo && user?.rol !== 'OWNER' && (
            <Alert color="orange" title="Fuera de plazo">
              Esta venta está fuera del plazo de devolución. Solo un dueño puede
              autorizarla.
            </Alert>
          )}

          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Producto</Table.Th>
                <Table.Th>Vendido</Table.Th>
                <Table.Th>Disponible</Table.Th>
                <Table.Th>A devolver</Table.Th>
                <Table.Th>Reingresa a stock</Table.Th>
                <Table.Th>Monto</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {saleInfo.items.map((item) => {
                const sel = selections[item.saleItemId];
                const cantidad = sel?.cantidad ?? 0;
                const montoCents = lineNetoADevolverCents(item, cantidad);
                return (
                  <Table.Tr key={item.saleItemId}>
                    <Table.Td>{item.descripcionSnapshot}</Table.Td>
                    <Table.Td>{item.cantidadVendida}</Table.Td>
                    <Table.Td>{item.cantidadDisponible}</Table.Td>
                    <Table.Td>
                      <NumberInput
                        value={cantidad}
                        min={0}
                        max={item.cantidadDisponible}
                        disabled={item.cantidadDisponible === 0}
                        onChange={(value) =>
                          setLineCantidad(
                            item,
                            typeof value === 'number' ? value : 0,
                          )
                        }
                        w={90}
                      />
                    </Table.Td>
                    <Table.Td>
                      <Checkbox
                        checked={sel?.reingresaStock ?? true}
                        disabled={!sel}
                        onChange={(event) =>
                          setLineReingresaStock(
                            item.saleItemId,
                            event.currentTarget.checked,
                          )
                        }
                      />
                    </Table.Td>
                    <Table.Td>
                      {cantidad > 0
                        ? formatCurrency(centsToAmountString(montoCents))
                        : '—'}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>

          {totalCents > 0 && (
            <>
              <Divider />

              <Group justify="space-between">
                <Text fw={700}>Total a devolver</Text>
                <Text fw={700}>
                  {formatCurrency(centsToAmountString(totalCents))}
                </Text>
              </Group>

              <Radio.Group
                label="Tipo de operación"
                value={tipo}
                onChange={(value) =>
                  setTipo(value === 'CAMBIO' ? 'CAMBIO' : 'DEVOLUCION')
                }
              >
                <Group mt="xs">
                  <Radio value="DEVOLUCION" label="Devolución simple" />
                  <Radio value="CAMBIO" label="Cambio por otra prenda" />
                </Group>
              </Radio.Group>

              {tipo === 'DEVOLUCION' && (
                <Card withBorder>
                  <PaymentLinesBuilder
                    label="Reintegro"
                    baseCents={totalCents}
                    lines={reintegroLines}
                    onChange={setReintegroLines}
                  />
                </Card>
              )}

              {tipo === 'CAMBIO' && (
                <Card withBorder>
                  <Stack>
                    <Text fw={500} size="sm">
                      Prenda nueva
                    </Text>
                    <div style={{ position: 'relative' }}>
                      <TextInput
                        placeholder="Buscá por nombre, SKU o código de barras…"
                        value={nuevaQuery}
                        onChange={(event) =>
                          setNuevaQuery(event.currentTarget.value)
                        }
                      />
                      {nuevaResults && nuevaResults.length > 0 && (
                        <Card
                          withBorder
                          shadow="sm"
                          p={0}
                          style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            zIndex: 10,
                          }}
                        >
                          <Table highlightOnHover>
                            <Table.Tbody>
                              {nuevaResults.map((result) => (
                                <Table.Tr
                                  key={result.id}
                                  onClick={() => addNuevaVariant(result)}
                                  style={{ cursor: 'pointer' }}
                                >
                                  <Table.Td>
                                    {buildDescripcion(result)}
                                  </Table.Td>
                                  <Table.Td>{result.sku}</Table.Td>
                                  <Table.Td>
                                    {formatCurrency(result.precioVenta)}
                                  </Table.Td>
                                </Table.Tr>
                              ))}
                            </Table.Tbody>
                          </Table>
                        </Card>
                      )}
                    </div>

                    {nuevaItems.length > 0 && (
                      <Table>
                        <Table.Tbody>
                          {nuevaItems.map((line) => (
                            <Table.Tr key={line.variantId}>
                              <Table.Td>{line.descripcion}</Table.Td>
                              <Table.Td>
                                <NumberInput
                                  value={line.cantidad}
                                  min={1}
                                  onChange={(value) =>
                                    setNuevaItems((prev) =>
                                      prev.map((l) =>
                                        l.variantId === line.variantId
                                          ? {
                                              ...l,
                                              cantidad:
                                                typeof value === 'number'
                                                  ? value
                                                  : 1,
                                            }
                                          : l,
                                      ),
                                    )
                                  }
                                  w={80}
                                />
                              </Table.Td>
                              <Table.Td>
                                {formatCurrency(line.precioVenta)}
                              </Table.Td>
                              <Table.Td>
                                <Button
                                  variant="subtle"
                                  color="red"
                                  size="xs"
                                  onClick={() =>
                                    quitarNuevaItem(line.variantId)
                                  }
                                >
                                  Quitar
                                </Button>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    )}

                    {nuevaItems.length > 0 && (
                      <>
                        <Group justify="space-between">
                          <Text size="sm">Total prenda nueva</Text>
                          <Text size="sm">
                            {formatCurrency(
                              centsToAmountString(nuevaVentaTotalCents),
                            )}
                          </Text>
                        </Group>
                        <Group justify="space-between">
                          <Text size="sm">Crédito de la devolución</Text>
                          <Text size="sm">
                            {formatCurrency(centsToAmountString(creditoCents))}
                          </Text>
                        </Group>

                        {diferenciaCents > 0 && (
                          <PaymentLinesBuilder
                            label="Diferencia a cobrar (prenda más cara)"
                            baseCents={diferenciaCents}
                            lines={diferenciaLines}
                            onChange={setDiferenciaLines}
                          />
                        )}

                        {extraCents > 0 && (
                          <PaymentLinesBuilder
                            label="Excedente a reintegrar (prenda más barata)"
                            baseCents={extraCents}
                            lines={extraReintegroLines}
                            onChange={setExtraReintegroLines}
                          />
                        )}
                      </>
                    )}
                  </Stack>
                </Card>
              )}
            </>
          )}

          {submitError && (
            <Alert color="red" title="No se pudo registrar">
              {submitError}
            </Alert>
          )}

          <Group justify="flex-end">
            <Button
              size="lg"
              disabled={
                (!puedeConfirmarDevolucion && !puedeConfirmarCambio) ||
                submitting
              }
              loading={submitting}
              onClick={() => void handleConfirmar()}
            >
              Confirmar {tipo === 'CAMBIO' ? 'cambio' : 'devolución'}
            </Button>
          </Group>
        </>
      )}
    </Stack>
  );
}
