import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import {
  ActionIcon,
  Alert,
  Button,
  Card,
  Center,
  Group,
  Kbd,
  Loader,
  Modal,
  NumberInput,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../lib/http-client';
import { formatCurrency } from '../../lib/format';
import { useIdempotencyKey } from '../../lib/idempotency';
import { searchVariants } from '../catalog/api';
import type { VariantSearchResult } from '../catalog/types';
import {
  addOrIncrementLine,
  centsToAmountString,
  changeLineQuantity,
  computeDiscountTotalCents,
  computeSubtotalCents,
  computeTotalCents,
  findExactMatch,
  lineSubtotalCents,
  removeLine,
  setLineQuantity,
  type CartLine,
  type DraftDiscount,
} from './cart';
import {
  clearDraft,
  loadDraft,
  saveDraft,
  DRAFT_STORAGE_KEY,
  IDEMPOTENCY_STORAGE_KEY,
} from './draft-storage';
import { DiscountModal } from './components/DiscountModal';

const SEARCH_PAGE_SIZE = 8;

// T4.10 (BLUEPRINT §12.1) — pantalla de armado del carrito, diseñada para
// teclado y lector de código de barras: el foco vive SIEMPRE en el
// buscador, y una venta completa se arma sin tocar el mouse. `F2` navega
// a `/venta/cobro` (T4.11, `CobroPage`), que lee este mismo borrador
// (`sessionStorage`, mismas claves vía `draft-storage.ts`) y su clave de
// idempotencia para confirmar la venta contra `POST /sales`.
export function SalePage() {
  const navigate = useNavigate();
  // Inicializador perezoso (no `useRef`+`.current` leído durante el
  // render, que la regla `react-hooks/refs` prohíbe): `loadDraft` solo
  // corre una vez, en el primer render.
  const [lines, setLines] = useState<CartLine[]>(
    () => loadDraft(sessionStorage, DRAFT_STORAGE_KEY).lines,
  );
  const [discounts, setDiscounts] = useState<DraftDiscount[]>(
    () => loadDraft(sessionStorage, DRAFT_STORAGE_KEY).discounts,
  );
  const [selectedLineIndex, setSelectedLineIndex] = useState<number | null>(
    null,
  );

  const [q, setQ] = useState('');
  const [debouncedQ] = useDebouncedValue(q, 200);
  const [searchResults, setSearchResults] = useState<
    VariantSearchResult[] | null
  >(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const [discountModalOpen, setDiscountModalOpen] = useState(false);
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);

  // Generada al entrar a la pantalla, no al confirmar (AD-10/§9.7) —
  // sobrevive a un F5 en `sessionStorage`, igual que el resto del
  // borrador. `CobroPage` (T4.11) es quien la manda en el header
  // `Idempotency-Key` al confirmar la venta; acá solo se garantiza que ya
  // existe y que no cambia mientras el borrador siga vivo, y se rota si
  // la venta se cancela.
  const { rotate: rotateIdempotencyKey } = useIdempotencyKey(
    IDEMPOTENCY_STORAGE_KEY,
  );

  const inputRef = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(() => {
    inputRef.current?.focus();
  }, []);

  // Persistencia del borrador — efecto de escritura pura a
  // `sessionStorage`, no `setState`, así que no dispara
  // `react-hooks/set-state-in-effect` (mismo motivo que sí hay que
  // evitarlo para la carga inicial async de `CashRegisterPage.tsx`, que
  // es un caso distinto).
  useEffect(() => {
    saveDraft(sessionStorage, DRAFT_STORAGE_KEY, { lines, discounts });
  }, [lines, discounts]);

  const addVariant = useCallback(
    (variant: VariantSearchResult) => {
      setLines((prev) => addOrIncrementLine(prev, variant));
      focusSearch();
    },
    [focusSearch],
  );

  // Cuando el término de búsqueda queda vacío, se limpia todo lo asociado
  // a la búsqueda anterior — ajustado durante el render (mismo patrón que
  // `CatalogPage.tsx` con `trackedQ`), no dentro del efecto de abajo: un
  // `setState` síncrono en el cuerpo de un efecto dispara
  // `react-hooks/set-state-in-effect`.
  const [trackedQ, setTrackedQ] = useState(debouncedQ);
  if (debouncedQ !== trackedQ) {
    setTrackedQ(debouncedQ);
    if (debouncedQ.trim()) {
      setSearchLoading(true);
    } else {
      setSearchResults(null);
      setSearchError(null);
      setSearchLoading(false);
      setDropdownOpen(false);
    }
  }

  useEffect(() => {
    const trimmed = debouncedQ.trim();
    if (!trimmed) return;

    let cancelled = false;

    searchVariants({ q: trimmed, pageSize: SEARCH_PAGE_SIZE })
      .then((data) => {
        if (cancelled) return;
        setSearchError(null);

        // §12.1 paso 2: coincidencia exacta de SKU/código de barras se
        // agrega sola, sin pasar por la lista navegable.
        const exact = findExactMatch(data.items, trimmed);
        if (exact) {
          addVariant(exact);
          setQ('');
          setSearchResults(null);
          setDropdownOpen(false);
          return;
        }

        setSearchResults(data.items);
        setDropdownOpen(data.items.length > 0);
        setHighlightedIndex(0);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSearchResults(null);
        setDropdownOpen(false);
        setSearchError(
          err instanceof ApiError
            ? err.message
            : 'No se pudo buscar. Probá de nuevo.',
        );
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [debouncedQ, addVariant]);

  const selectedLine =
    selectedLineIndex !== null ? (lines[selectedLineIndex] ?? null) : null;

  const subtotalCents = computeSubtotalCents(lines);
  const discountCents = computeDiscountTotalCents(discounts, subtotalCents);
  const totalCents = computeTotalCents(subtotalCents, discountCents);

  function chooseResult(index: number): void {
    const chosen = searchResults?.[index];
    if (!chosen) return;
    addVariant(chosen);
    setQ('');
    setSearchResults(null);
    setDropdownOpen(false);
  }

  // Ticket nuevo (post Release Candidate) — hallazgo real de la
  // auto-revisión del sistema: sacar un producto del carrito solo existía
  // como atajo (Ctrl+Supr), sin ningún botón visible — a diferencia de
  // Devoluciones, que sí tiene "Quitar" en sus listas equivalentes
  // (`quitarNuevaItem`, `PaymentLinesBuilder.quitarLinea`). Usado tanto
  // por el botón nuevo de cada fila como por el atajo, que sigue andando
  // igual que antes para quien ya lo conoce.
  function handleRemoveLine(variantId: number): void {
    setLines((prev) => removeLine(prev, variantId));
    setSelectedLineIndex(null);
    focusSearch();
  }

  function handleCancelSale(): void {
    setLines([]);
    setDiscounts([]);
    setSelectedLineIndex(null);
    clearDraft(sessionStorage, DRAFT_STORAGE_KEY);
    // Se abandona el borrador que esta clave protegía — la próxima venta
    // arranca con una clave propia, nunca reutiliza la de una venta
    // cancelada.
    rotateIdempotencyKey();
    setCancelConfirmOpen(false);
    focusSearch();
  }

  // Atajos de §12.1. Los que llevan modificador (`Ctrl` + `+`/`−`/`Supr`)
  // van primero y a propósito: sin chequear el modificador, tipear un SKU
  // con un guion en el buscador —que siempre tiene el foco— modificaría
  // el carrito en vez de escribir.
  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.ctrlKey && (event.key === '+' || event.key === '=')) {
      event.preventDefault();
      if (selectedLine) {
        setLines((prev) => changeLineQuantity(prev, selectedLine.variantId, 1));
      }
      return;
    }
    if (event.ctrlKey && event.key === '-') {
      event.preventDefault();
      if (selectedLine) {
        setLines((prev) =>
          changeLineQuantity(prev, selectedLine.variantId, -1),
        );
      }
      return;
    }
    if (event.ctrlKey && event.key === 'Delete') {
      event.preventDefault();
      if (selectedLine) {
        handleRemoveLine(selectedLine.variantId);
      }
      return;
    }

    if (event.key === 'F2') {
      event.preventDefault();
      if (lines.length > 0) void navigate('/venta/cobro');
      return;
    }
    if (event.key === 'F4') {
      event.preventDefault();
      setDiscountModalOpen(true);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      if (dropdownOpen) {
        setDropdownOpen(false);
        setSearchResults(null);
        return;
      }
      if (lines.length > 0 || discounts.length > 0 || q.trim()) {
        setCancelConfirmOpen(true);
      }
      return;
    }

    if (dropdownOpen && searchResults && searchResults.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, searchResults.length - 1));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        chooseResult(highlightedIndex);
        return;
      }
      return;
    }

    // Lista cerrada: las flechas navegan las líneas ya cargadas (§12.1,
    // literal — "la única lectura que no obliga a soltar el teclado").
    if (event.key === 'ArrowDown' && lines.length > 0) {
      event.preventDefault();
      setSelectedLineIndex((i) =>
        i === null ? 0 : Math.min(i + 1, lines.length - 1),
      );
      return;
    }
    if (event.key === 'ArrowUp' && lines.length > 0) {
      event.preventDefault();
      setSelectedLineIndex((i) =>
        i === null ? lines.length - 1 : Math.max(i - 1, 0),
      );
    }
  }

  return (
    <Stack>
      <Title order={3}>Venta</Title>

      <div style={{ position: 'relative' }}>
        <TextInput
          ref={inputRef}
          autoFocus
          placeholder="Escaneá o buscá por nombre, SKU o código de barras…"
          value={q}
          onChange={(event) => setQ(event.currentTarget.value)}
          onKeyDown={handleSearchKeyDown}
          rightSection={searchLoading ? <Loader size="xs" /> : null}
        />

        {dropdownOpen && searchResults && searchResults.length > 0 && (
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
                {searchResults.map((result, index) => (
                  <Table.Tr
                    key={result.id}
                    onClick={() => chooseResult(index)}
                    style={{
                      cursor: 'pointer',
                      backgroundColor:
                        index === highlightedIndex
                          ? 'var(--mantine-color-blue-light)'
                          : undefined,
                    }}
                  >
                    <Table.Td>
                      {[
                        result.product.nombre,
                        result.size?.nombre,
                        result.color?.nombre,
                      ]
                        .filter(Boolean)
                        .join(' - ')}
                    </Table.Td>
                    <Table.Td>{result.sku}</Table.Td>
                    <Table.Td>{formatCurrency(result.precioVenta)}</Table.Td>
                    <Table.Td>Stock: {result.stockActual}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Card>
        )}
      </div>

      {searchError && (
        <Alert color="red" title="No se pudo buscar">
          {searchError}
        </Alert>
      )}

      {searchResults !== null &&
        searchResults.length === 0 &&
        !searchLoading && (
          <Text c="dimmed" size="sm">
            No se encontró nada para "{debouncedQ.trim()}". El foco sigue acá,
            la venta en curso no se pierde.
          </Text>
        )}

      {lines.length === 0 ? (
        <Center py="xl">
          <Text c="dimmed">Escaneá o buscá un producto para empezar.</Text>
        </Center>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Producto</Table.Th>
              <Table.Th>SKU</Table.Th>
              <Table.Th>Cantidad</Table.Th>
              <Table.Th>Precio</Table.Th>
              <Table.Th>Subtotal</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {lines.map((line, index) => (
              <Table.Tr
                key={line.variantId}
                onClick={() => setSelectedLineIndex(index)}
                style={{
                  cursor: 'pointer',
                  backgroundColor:
                    index === selectedLineIndex
                      ? 'var(--mantine-color-blue-light)'
                      : undefined,
                }}
              >
                <Table.Td>{line.descripcion}</Table.Td>
                <Table.Td>{line.sku}</Table.Td>
                <Table.Td onClick={(event) => event.stopPropagation()}>
                  <Group gap="xs" wrap="nowrap">
                    <NumberInput
                      value={line.cantidad}
                      min={1}
                      step={1}
                      w={80}
                      onChange={(value) =>
                        setLines((prev) =>
                          setLineQuantity(
                            prev,
                            line.variantId,
                            typeof value === 'number' ? value : 1,
                          ),
                        )
                      }
                    />
                    {line.cantidad > line.stockActual && (
                      <Text span c="red" size="xs">
                        Sin stock suficiente (quedan {line.stockActual})
                      </Text>
                    )}
                  </Group>
                </Table.Td>
                <Table.Td>{formatCurrency(line.precioVenta)}</Table.Td>
                <Table.Td>
                  {formatCurrency(centsToAmountString(lineSubtotalCents(line)))}
                </Table.Td>
                <Table.Td onClick={(event) => event.stopPropagation()}>
                  <Button
                    variant="subtle"
                    color="red"
                    size="xs"
                    onClick={() => handleRemoveLine(line.variantId)}
                  >
                    Quitar
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {discounts.length > 0 && (
        <Card withBorder>
          <Stack gap="xs">
            <Text fw={500} size="sm">
              Descuentos
            </Text>
            {discounts.map((discount) => (
              <Group key={discount.id} justify="space-between">
                <Text size="sm">
                  {discount.descripcion}
                  {discount.porcentaje !== undefined
                    ? ` (${discount.porcentaje}%)`
                    : ` (${formatCurrency(discount.monto ?? '0')})`}
                </Text>
                <ActionIcon
                  variant="subtle"
                  color="red"
                  onClick={() => {
                    setDiscounts((prev) =>
                      prev.filter((d) => d.id !== discount.id),
                    );
                    focusSearch();
                  }}
                  aria-label="Quitar descuento"
                >
                  ×
                </ActionIcon>
              </Group>
            ))}
          </Stack>
        </Card>
      )}

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
          <Group justify="space-between">
            <Text fw={700}>Total</Text>
            <Text fw={700}>
              {formatCurrency(centsToAmountString(totalCents))}
            </Text>
          </Group>
        </Stack>
      </Card>

      <Group justify="space-between">
        <Group gap="xs">
          <Button
            variant="default"
            onClick={() => {
              setDiscountModalOpen(true);
            }}
          >
            <Kbd mr={6}>F4</Kbd> Descuento
          </Button>
          <Button
            variant="default"
            color="red"
            disabled={lines.length === 0 && discounts.length === 0 && !q.trim()}
            onClick={() => setCancelConfirmOpen(true)}
          >
            <Kbd mr={6}>Esc</Kbd> Cancelar venta
          </Button>
        </Group>
        <Button
          disabled={lines.length === 0}
          onClick={() => void navigate('/venta/cobro')}
        >
          <Kbd mr={6}>F2</Kbd> Ir a cobrar
        </Button>
      </Group>

      {selectedLine && (
        <Text size="xs" c="dimmed">
          Línea seleccionada: {selectedLine.descripcion} — <Kbd>Ctrl</Kbd>+
          <Kbd>+</Kbd>/<Kbd>−</Kbd> cambia la cantidad, <Kbd>Ctrl</Kbd>+
          <Kbd>Supr</Kbd> la quita.
        </Text>
      )}

      {discountModalOpen && (
        <DiscountModal
          onClose={() => {
            setDiscountModalOpen(false);
            focusSearch();
          }}
          onAdd={(discount) => {
            setDiscounts((prev) => [...prev, discount]);
            setDiscountModalOpen(false);
            focusSearch();
          }}
        />
      )}

      {cancelConfirmOpen && (
        <Modal
          opened
          onClose={() => {
            setCancelConfirmOpen(false);
            focusSearch();
          }}
          title="Cancelar venta"
        >
          <Stack>
            <Text>
              Se van a perder {lines.length}{' '}
              {lines.length === 1 ? 'producto cargado' : 'productos cargados'}.
              ¿Confirmás?
            </Text>
            <Group justify="flex-end">
              <Button
                variant="default"
                onClick={() => {
                  setCancelConfirmOpen(false);
                  focusSearch();
                }}
              >
                Seguir vendiendo
              </Button>
              <Button color="red" onClick={handleCancelSale}>
                Cancelar venta
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
