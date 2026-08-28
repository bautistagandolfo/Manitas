import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  NumberInput,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/http-client';
import { formatCurrency } from '../../lib/format';
import { parseNumberInputValue } from '../../lib/number-input';
import { useIdempotencyKey } from '../../lib/idempotency';
import { consultarCredito } from '../returns/api';
import type { CreditoDevolucionInfo } from '../returns/types';
import { createSale } from './api';
import {
  centsToAmountString,
  computeDiscountTotalCents,
  computeSubtotalCents,
  computeTotalCents,
  toCents,
} from './cart';
import {
  clearDraft,
  loadDraft,
  DRAFT_STORAGE_KEY,
  IDEMPOTENCY_STORAGE_KEY,
} from './draft-storage';
import { saldoPendienteCents, sumPaymentsCents, vueltoCents } from './payments';
import type { DraftPayment } from './payments';
import type { PaymentMetodo } from './types';

const METODOS: Array<{
  key: '1' | '2' | '3' | '4' | '5';
  metodo: PaymentMetodo;
  label: string;
}> = [
  { key: '1', metodo: 'EFECTIVO', label: 'Efectivo' },
  { key: '2', metodo: 'TARJETA_DEBITO', label: 'Débito' },
  { key: '3', metodo: 'TARJETA_CREDITO', label: 'Crédito' },
  { key: '4', metodo: 'TRANSFERENCIA', label: 'Transferencia' },
  // T5.8 (AMB-16 diferida) — a diferencia de los otros 4, este medio no
  // puede precargar el importe apenas se elige: primero hace falta
  // buscar la devolución (`buscarCredito`) para saber cuánto crédito
  // tiene disponible.
  { key: '5', metodo: 'CREDITO_DEVOLUCION', label: 'Crédito devolución' },
];

// T4.11 (BLUEPRINT §12.1, "Pantalla de cobro") — lee el borrador armado
// en T4.10 (`sessionStorage`, mismas claves vía `draft-storage.ts`) y lo
// confirma contra `POST /sales` (T4.11 backend). El foco arranca en el
// selector de medio de pago, no en el importe: ahí las teclas 1-4 eligen
// medio; `Enter`/`Tab` pasa al importe (precargado con el saldo
// pendiente); otro `Enter` confirma esa línea de pago. Con el foco en el
// importe, las teclas numéricas escriben el número — nunca cambian el
// medio (el atajo 1-4 solo está atado al selector).
export function CobroPage() {
  const navigate = useNavigate();
  const draft = useState(() => loadDraft(sessionStorage, DRAFT_STORAGE_KEY))[0];
  const { key: idempotencyKey, rotate: rotateIdempotencyKey } =
    useIdempotencyKey(IDEMPOTENCY_STORAGE_KEY);

  const [ajusteRedondeo, setAjusteRedondeo] = useState<number | ''>('');
  const [payments, setPayments] = useState<DraftPayment[]>([]);

  const [selectedMetodo, setSelectedMetodo] = useState<PaymentMetodo | null>(
    null,
  );
  const [importeValue, setImporteValue] = useState<number | ''>('');
  const [entregadoValue, setEntregadoValue] = useState<number | ''>('');
  const [lineError, setLineError] = useState<string | null>(null);

  // T5.8 (AMB-16 diferida) — estado propio de la búsqueda de crédito,
  // separado del resto: es el único medio de pago que necesita un paso
  // previo (consultar `GET /returns/:numero/credito`) antes de poder
  // cargar un importe.
  const [creditoNumeroValue, setCreditoNumeroValue] = useState<number | ''>('');
  const [creditoInfo, setCreditoInfo] = useState<CreditoDevolucionInfo | null>(
    null,
  );
  const [creditoLoading, setCreditoLoading] = useState(false);
  const [creditoError, setCreditoError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const selectorRef = useRef<HTMLDivElement>(null);
  const importeRef = useRef<HTMLInputElement>(null);

  // Sin nada cargado no hay nada que cobrar — vuelve al armado del
  // carrito en vez de mostrar una pantalla de cobro vacía.
  useEffect(() => {
    if (draft.lines.length === 0) {
      void navigate('/venta', { replace: true });
    }
  }, [draft.lines.length, navigate]);

  const subtotalCents = computeSubtotalCents(draft.lines);
  const discountCents = computeDiscountTotalCents(
    draft.discounts,
    subtotalCents,
  );
  const ajusteCents =
    ajusteRedondeo === '' ? 0 : Math.round(ajusteRedondeo * 100);
  const totalCents = computeTotalCents(
    subtotalCents,
    discountCents,
    ajusteCents,
  );
  const pagadoCents = sumPaymentsCents(payments);
  const saldoCents = saldoPendienteCents(totalCents, payments);
  const puedeConfirmarVenta = saldoCents === 0 && payments.length > 0;

  const focusSelector = useCallback(() => {
    selectorRef.current?.focus();
  }, []);

  // Elegir un medio ya deja el importe precargado con el saldo
  // pendiente (§12.1) — así el mouse (un solo click) y el teclado (1-4 +
  // Enter/Tab, que solo mueve el foco) llegan al mismo estado.
  //
  // T5.8: "Crédito devolución" es la excepción — no hay ningún saldo
  // conocido hasta buscar la devolución, así que el importe queda
  // vacío hasta que `buscarCredito` lo precargue.
  function elegirMetodo(metodo: PaymentMetodo): void {
    setSelectedMetodo(metodo);
    setImporteValue(
      metodo !== 'CREDITO_DEVOLUCION' && saldoCents > 0
        ? Number(centsToAmountString(saldoCents))
        : '',
    );
    setEntregadoValue('');
    setLineError(null);
    setCreditoNumeroValue('');
    setCreditoInfo(null);
    setCreditoError(null);
  }

  function irAImporte(): void {
    if (!selectedMetodo) return;
    importeRef.current?.focus();
  }

  // T5.8 — busca la devolución por su propio número (el comprobante que
  // la clienta presenta, no el de la venta original) y precarga el
  // importe con el menor entre "saldo pendiente de esta venta" y
  // "crédito disponible de esa devolución" — mismo criterio de UX que
  // los atajos 1-4 ya construidos en T4.11. El backend vuelve a validar
  // el límite real al confirmar (invariante 14); esto es una previsión
  // de pantalla, nunca la última palabra.
  async function buscarCredito(): Promise<void> {
    if (typeof creditoNumeroValue !== 'number' || creditoNumeroValue <= 0) {
      setCreditoError('Ingresá el número de devolución');
      return;
    }
    setCreditoLoading(true);
    setCreditoError(null);
    try {
      const info = await consultarCredito(creditoNumeroValue);
      setCreditoInfo(info);
      const disponibleCents = toCents(info.creditoDisponible);
      const aplicarCents = Math.min(saldoCents, disponibleCents);
      setImporteValue(
        aplicarCents > 0 ? Number(centsToAmountString(aplicarCents)) : '',
      );
      if (disponibleCents <= 0) {
        setCreditoError('Esta devolución no tiene crédito disponible');
      }
    } catch (err) {
      setCreditoInfo(null);
      setImporteValue('');
      setCreditoError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo consultar el crédito. Probá de nuevo.',
      );
    } finally {
      setCreditoLoading(false);
    }
  }

  function confirmarLineaDePago(): void {
    if (!selectedMetodo) return;
    if (selectedMetodo === 'CREDITO_DEVOLUCION' && !creditoInfo) {
      setLineError('Buscá la devolución antes de confirmar');
      return;
    }
    if (typeof importeValue !== 'number' || importeValue <= 0) {
      setLineError('Ingresá un importe mayor a 0');
      return;
    }
    const montoCents = toCents(importeValue);
    if (montoCents > saldoCents) {
      setLineError(
        `El importe no puede superar el saldo pendiente (${formatCurrency(centsToAmountString(saldoCents))})`,
      );
      return;
    }
    if (
      selectedMetodo === 'CREDITO_DEVOLUCION' &&
      creditoInfo &&
      montoCents > toCents(creditoInfo.creditoDisponible)
    ) {
      setLineError(
        `El importe no puede superar el crédito disponible (${formatCurrency(creditoInfo.creditoDisponible)})`,
      );
      return;
    }

    setPayments((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        metodo: selectedMetodo,
        monto: importeValue.toFixed(2),
        ...(selectedMetodo === 'CREDITO_DEVOLUCION' && creditoInfo
          ? {
              returnId: creditoInfo.returnId,
              referencia: `Devolución #${creditoInfo.numero}`,
            }
          : {}),
      },
    ]);
    setSelectedMetodo(null);
    setImporteValue('');
    setEntregadoValue('');
    setLineError(null);
    setCreditoNumeroValue('');
    setCreditoInfo(null);
    setCreditoError(null);
    focusSelector();
  }

  function quitarPago(id: string): void {
    setPayments((prev) => prev.filter((p) => p.id !== id));
    focusSelector();
  }

  // Atajos del selector de medio: 1-4 eligen, Enter/Tab pasa al importe.
  // Nunca interceptan si el foco está en el campo de importe (ese
  // handler es otro, más abajo) — BLUEPRINT §12.1, literal.
  function handleSelectorKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const found = METODOS.find((m) => m.key === event.key);
    if (found) {
      event.preventDefault();
      elegirMetodo(found.metodo);
      return;
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && selectedMetodo) {
      event.preventDefault();
      irAImporte();
    }
  }

  function handleImporteKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      confirmarLineaDePago();
    }
  }

  async function handleConfirmarVenta(): Promise<void> {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const sale = await createSale(
        {
          items: draft.lines.map((line) => ({
            variantId: line.variantId,
            cantidad: line.cantidad,
          })),
          payments: payments.map((p) => ({
            metodo: p.metodo,
            monto: p.monto,
            ...(p.returnId !== undefined ? { returnId: p.returnId } : {}),
            ...(p.referencia !== undefined ? { referencia: p.referencia } : {}),
          })),
          discounts:
            draft.discounts.length > 0
              ? draft.discounts.map((d) => ({
                  descripcion: d.descripcion,
                  porcentaje: d.porcentaje,
                  monto: d.monto,
                }))
              : undefined,
          ajusteRedondeo:
            ajusteRedondeo === '' ? undefined : ajusteRedondeo.toFixed(2),
        },
        idempotencyKey,
      );

      clearDraft(sessionStorage, DRAFT_STORAGE_KEY);
      rotateIdempotencyKey();
      notifications.show({
        color: 'green',
        title: 'Venta registrada',
        message: `Venta #${sale.numero} por ${formatCurrency(sale.total)}`,
      });
      void navigate('/venta', { replace: true });
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo registrar la venta. Probá de nuevo.',
      );
      setSubmitting(false);
    }
  }

  if (draft.lines.length === 0) {
    return null;
  }

  const vuelto =
    selectedMetodo === 'EFECTIVO' &&
    typeof entregadoValue === 'number' &&
    typeof importeValue === 'number'
      ? vueltoCents(toCents(entregadoValue), toCents(importeValue))
      : null;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={3}>Cobrar</Title>
        <Button variant="default" onClick={() => void navigate('/venta')}>
          Volver a la venta
        </Button>
      </Group>

      <Card withBorder>
        <Stack gap={4}>
          <Group justify="space-between">
            <Text>Subtotal</Text>
            <Text>{formatCurrency(centsToAmountString(subtotalCents))}</Text>
          </Group>
          {discountCents > 0 && (
            <Group justify="space-between">
              <Text>Descuento</Text>
              <Text c="red">
                −{formatCurrency(centsToAmountString(discountCents))}
              </Text>
            </Group>
          )}
          <NumberInput
            label="Ajuste de redondeo (opcional)"
            description="Lo carga quien cobra — por ejemplo, para cerrar en un número redondo."
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            min={-0.99}
            max={0.99}
            step={0.01}
            prefix="$ "
            disabled={submitting || payments.length > 0}
            value={ajusteRedondeo}
            onChange={(value) =>
              setAjusteRedondeo(parseNumberInputValue(value))
            }
          />
          <Group justify="space-between">
            <Text fw={700}>Total</Text>
            <Text fw={700}>
              {formatCurrency(centsToAmountString(totalCents))}
            </Text>
          </Group>
        </Stack>
      </Card>

      {payments.length > 0 && (
        <Card withBorder>
          <Stack gap="xs">
            <Text fw={500} size="sm">
              Pagos cargados
            </Text>
            {payments.map((p) => (
              <Group key={p.id} justify="space-between">
                <Text size="sm">
                  {METODOS.find((m) => m.metodo === p.metodo)?.label ??
                    p.metodo}{' '}
                  — {formatCurrency(p.monto)}
                  {p.referencia ? ` (${p.referencia})` : ''}
                </Text>
                <Button
                  variant="subtle"
                  color="red"
                  size="xs"
                  onClick={() => quitarPago(p.id)}
                >
                  Quitar
                </Button>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

      {saldoCents > 0 ? (
        <Card withBorder>
          <Stack>
            <Group justify="space-between">
              <Text fw={700}>Saldo pendiente</Text>
              <Text fw={700}>
                {formatCurrency(centsToAmountString(saldoCents))}
              </Text>
            </Group>

            <Text size="sm" c="dimmed">
              Elegí el medio de pago (1-5) y confirmá con Enter para pasar al
              importe.
            </Text>
            <Group
              ref={selectorRef}
              tabIndex={0}
              onKeyDown={handleSelectorKeyDown}
              gap="xs"
              role="radiogroup"
              aria-label="Medio de pago"
              style={{ outline: 'none' }}
            >
              {METODOS.map((m) => (
                <Paper
                  key={m.metodo}
                  withBorder
                  p="sm"
                  role="radio"
                  aria-checked={selectedMetodo === m.metodo}
                  onClick={() => {
                    elegirMetodo(m.metodo);
                    focusSelector();
                  }}
                  style={{
                    cursor: 'pointer',
                    backgroundColor:
                      selectedMetodo === m.metodo
                        ? 'var(--mantine-color-blue-light)'
                        : undefined,
                  }}
                >
                  <Text size="sm" component="span">
                    <Badge variant="light" mr={6} size="sm">
                      {m.key}
                    </Badge>
                    {m.label}
                  </Text>
                </Paper>
              ))}
            </Group>

            {selectedMetodo === 'CREDITO_DEVOLUCION' && (
              <Group align="flex-end">
                <NumberInput
                  label="Número de devolución"
                  description="El comprobante que presenta la clienta"
                  min={1}
                  value={creditoNumeroValue}
                  onChange={(value) =>
                    setCreditoNumeroValue(parseNumberInputValue(value))
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      void buscarCredito();
                    }
                  }}
                  error={creditoError}
                />
                <Button
                  variant="default"
                  loading={creditoLoading}
                  onClick={() => void buscarCredito()}
                >
                  Buscar crédito
                </Button>
                {creditoInfo && (
                  <Text size="sm" c="dimmed">
                    Disponible: {formatCurrency(creditoInfo.creditoDisponible)}
                  </Text>
                )}
              </Group>
            )}

            {selectedMetodo &&
              (selectedMetodo !== 'CREDITO_DEVOLUCION' || creditoInfo) && (
                <Group align="flex-end">
                  <NumberInput
                    ref={importeRef}
                    label="Importe"
                    description="Enter confirma este pago"
                    decimalScale={2}
                    fixedDecimalScale
                    decimalSeparator=","
                    thousandSeparator="."
                    min={0.01}
                    prefix="$ "
                    value={importeValue}
                    onChange={(value) =>
                      setImporteValue(parseNumberInputValue(value))
                    }
                    onKeyDown={handleImporteKeyDown}
                    error={lineError}
                  />
                  {selectedMetodo === 'EFECTIVO' && (
                    <NumberInput
                      label="¿Cuánto entregó?"
                      description="Solo para calcular el vuelto — no se guarda"
                      decimalScale={2}
                      fixedDecimalScale
                      decimalSeparator=","
                      thousandSeparator="."
                      min={0}
                      prefix="$ "
                      value={entregadoValue}
                      onChange={(value) =>
                        setEntregadoValue(parseNumberInputValue(value))
                      }
                    />
                  )}
                  <Button onClick={confirmarLineaDePago}>Confirmar pago</Button>
                </Group>
              )}

            {vuelto !== null && vuelto > 0 && (
              <Alert color="blue" title="Vuelto">
                {formatCurrency(centsToAmountString(vuelto))}
              </Alert>
            )}
          </Stack>
        </Card>
      ) : (
        <Alert color="green" title="Pagos completos">
          La suma de los pagos cubre el total. Confirmá para registrar la venta.
        </Alert>
      )}

      {submitError && (
        <Alert color="red" title="No se pudo registrar la venta">
          {submitError}
        </Alert>
      )}

      <Group justify="flex-end">
        <Button
          size="lg"
          disabled={!puedeConfirmarVenta || submitting}
          loading={submitting}
          onClick={() => void handleConfirmarVenta()}
        >
          Confirmar venta
        </Button>
      </Group>

      {pagadoCents > 0 && saldoCents > 0 && (
        <Text size="xs" c="dimmed" ta="right">
          Pagado hasta ahora: {formatCurrency(centsToAmountString(pagadoCents))}
        </Text>
      )}
    </Stack>
  );
}
