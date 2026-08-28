import { useState } from 'react';
import { Button, Group, NumberInput, Select, Stack, Text } from '@mantine/core';
import { formatCurrency } from '../../../lib/format';
import { parseNumberInputValue } from '../../../lib/number-input';
import {
  centsToAmountString,
  saldoReintegroCents,
  sumReintegrosCents,
  toCents,
  type DraftReintegro,
} from '../calc';

const METODO_LABELS: Record<string, string> = {
  EFECTIVO: 'Efectivo',
  TARJETA_DEBITO: 'Débito',
  TARJETA_CREDITO: 'Crédito',
  TRANSFERENCIA: 'Transferencia',
  // T5.8 (AMB-16 diferida) — solo se ofrece cuando `allowCredito` está
  // activo (ver abajo): tiene sentido como reintegro de una devolución
  // simple (banca un crédito real, usable en una venta futura y
  // separada), pero NUNCA como excedente a reintegrar o diferencia a
  // cobrar de un cambio — ahí el crédito ya se está gastando en el
  // acto, no tiene sentido pagarlo con crédito.
  CREDITO_DEVOLUCION: 'Crédito de devolución',
};

const METODO_OPTIONS_BASE = [
  'EFECTIVO',
  'TARJETA_DEBITO',
  'TARJETA_CREDITO',
  'TRANSFERENCIA',
].map((value) => ({ value, label: METODO_LABELS[value] }));

const METODO_OPTIONS_CON_CREDITO = [
  ...METODO_OPTIONS_BASE,
  { value: 'CREDITO_DEVOLUCION', label: METODO_LABELS.CREDITO_DEVOLUCION },
];

// T5.7 — constructor de líneas "medio + importe" reusado en tres
// contextos de la pantalla de devolución/cambio: el reintegro de una
// devolución simple, el excedente a reintegrar de un cambio con prenda
// más barata, y la diferencia a cobrar de un cambio con prenda más cara
// — todos comparten la misma regla (RN-7/invariante 11 y la invariante
// 3 de `sales`): la suma de las líneas tiene que coincidir EXACTO con un
// total ya conocido, nunca aproximado. Deliberadamente más simple que el
// selector de `CobroPage` (sin atajos 1-4 ni foco automático): acá es un
// paso secundario del flujo, no la pantalla principal de cobro.
// `baseCents` (nombrado así, no "totalCents", para no chocar con la
// regla local `no-number-money` — mismo criterio que `calc.ts`).
export function PaymentLinesBuilder({
  baseCents,
  lines,
  onChange,
  label,
  allowCredito = false,
}: {
  baseCents: number;
  lines: DraftReintegro[];
  onChange: (lines: DraftReintegro[]) => void;
  label: string;
  // T5.8 (AMB-16 diferida) — default `false`: solo la "Reintegro" de una
  // devolución simple lo activa. Ver comentario de `METODO_LABELS`.
  allowCredito?: boolean;
}) {
  const metodoOptions = allowCredito
    ? METODO_OPTIONS_CON_CREDITO
    : METODO_OPTIONS_BASE;
  const [metodo, setMetodo] = useState<string | null>('EFECTIVO');
  const [importe, setImporte] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);

  const pagadoCents = sumReintegrosCents(lines);
  const saldoCents = saldoReintegroCents(baseCents, lines);

  function agregarLinea(): void {
    if (!metodo) {
      setError('Elegí un medio de pago');
      return;
    }
    if (typeof importe !== 'number' || importe <= 0) {
      setError('Ingresá un importe mayor a 0');
      return;
    }
    const montoCents = toCents(importe);
    if (montoCents > saldoCents) {
      setError(
        `El importe no puede superar el saldo pendiente (${formatCurrency(centsToAmountString(saldoCents))})`,
      );
      return;
    }
    onChange([
      ...lines,
      {
        id: crypto.randomUUID(),
        metodo,
        monto: importe.toFixed(2),
      },
    ]);
    setImporte('');
    setError(null);
  }

  function quitarLinea(id: string): void {
    onChange(lines.filter((l) => l.id !== id));
  }

  return (
    <Stack gap="xs">
      <Text fw={500} size="sm">
        {label}
      </Text>

      {lines.length > 0 && (
        <Stack gap={4}>
          {lines.map((line) => (
            <Group key={line.id} justify="space-between">
              <Text size="sm">
                {METODO_LABELS[line.metodo] ?? line.metodo} —{' '}
                {formatCurrency(line.monto)}
              </Text>
              <Button
                variant="subtle"
                color="red"
                size="xs"
                onClick={() => quitarLinea(line.id)}
              >
                Quitar
              </Button>
            </Group>
          ))}
        </Stack>
      )}

      {saldoCents > 0 ? (
        <Group align="flex-end">
          <Select
            label="Medio"
            data={metodoOptions}
            value={metodo}
            onChange={setMetodo}
            allowDeselect={false}
            w={160}
          />
          <NumberInput
            label="Importe"
            decimalScale={2}
            fixedDecimalScale
            decimalSeparator=","
            thousandSeparator="."
            min={0.01}
            prefix="$ "
            value={importe}
            onChange={(value) => setImporte(parseNumberInputValue(value))}
            error={error}
            w={160}
          />
          <Button onClick={agregarLinea}>Agregar</Button>
        </Group>
      ) : (
        <Text size="sm" c="green">
          Cubierto por completo.
        </Text>
      )}

      <Text size="xs" c="dimmed">
        {formatCurrency(centsToAmountString(pagadoCents))} de{' '}
        {formatCurrency(centsToAmountString(baseCents))}
      </Text>
    </Stack>
  );
}
