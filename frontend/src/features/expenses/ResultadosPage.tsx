import { useEffect, useState } from 'react';
import {
  Alert,
  Center,
  Grid,
  Group,
  Loader,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { ApiError } from '../../lib/http-client';
import {
  formatCurrency,
  formatDateTime,
  formatPercent,
} from '../../lib/format';
import {
  getGastosPorCategoria,
  getRankingProductos,
  getResultados,
} from './api';
import type {
  GastoPorCategoriaItem,
  OrdenRanking,
  RankingProductoItem,
  ResultadosResumen,
} from './types';

// Formato de "pared" YYYY-MM-DD que pide `<input type="date">` y la API
// (`?desde=&hasta=`) — no es formato de PANTALLA (eso es `formatDate` de
// `lib/format.ts`, dd/mm/aaaa), así que no compite con la regla de "nunca
// formatear fecha a mano en un componente": esto es el valor que viaja
// por el wire, no lo que lee la dueña.
function toIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function primerDiaDelMes(referencia: Date): Date {
  return new Date(referencia.getFullYear(), referencia.getMonth(), 1);
}

type Estado =
  | { status: 'loading' }
  | {
      status: 'ok';
      resumen: ResultadosResumen;
      ranking: RankingProductoItem[];
      gastosPorCategoria: GastoPorCategoriaItem[];
    }
  | { status: 'error'; message: string };

// T6.4-T6.6/T6.8 — RN-11 (OWNER-only, ya cubierto por `RequireOwner`):
// resumen de ingresos/CMV/margen/gastos/resultado neto + ranking de
// productos + gastos por categoría, todo sobre el mismo rango de fechas
// (RN-10, "mismo rango y mismos filtros que /resultados"). RN-9: "al día
// de hoy, no una foto inmutable" — `calculadoEn` se muestra siempre, para
// que un número de ayer y uno de hoy se puedan explicar.
export function ResultadosPage() {
  const hoy = new Date();
  const [desde, setDesde] = useState(() => toIsoDate(primerDiaDelMes(hoy)));
  const [hasta, setHasta] = useState(() => toIsoDate(hoy));
  const [orden, setOrden] = useState<OrdenRanking>('unidades');
  const [state, setState] = useState<Estado>({ status: 'loading' });

  // Puramente derivado de `desde`/`hasta` — se calcula durante el render,
  // no en el efecto (no hay ninguna operación async de por medio en este
  // caso, así que no corresponde un efecto: "you might not need an
  // effect", `react-hooks/set-state-in-effect`).
  const rangoInvalido = Boolean(desde) && Boolean(hasta) && desde > hasta;

  // Cuando cambian los parámetros de la consulta (y el rango es válido),
  // marca una carga nueva — ajuste durante el render, mismo motivo que
  // arriba: el efecto de abajo solo debe llamar `setState` colgado de la
  // promesa (resultado async), nunca de entrada.
  const paramsActuales = `${desde}|${hasta}|${orden}`;
  const [trackedParams, setTrackedParams] = useState(paramsActuales);
  if (paramsActuales !== trackedParams && !rangoInvalido) {
    setTrackedParams(paramsActuales);
    setState({ status: 'loading' });
  }

  useEffect(() => {
    let cancelled = false;

    if (!desde || !hasta || desde > hasta) return;

    Promise.all([
      getResultados(desde, hasta),
      getRankingProductos(desde, hasta, orden),
      getGastosPorCategoria(desde, hasta),
    ])
      .then(([resumen, ranking, gastosPorCategoria]) => {
        if (!cancelled) {
          setState({ status: 'ok', resumen, ranking, gastosPorCategoria });
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              err instanceof ApiError
                ? err.message
                : 'No se pudieron cargar los resultados. Probá de nuevo.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [desde, hasta, orden]);

  return (
    <Stack>
      <Title order={3}>Resultados</Title>

      <Group>
        <TextInput
          label="Desde"
          type="date"
          value={desde}
          onChange={(event) => setDesde(event.currentTarget.value)}
        />
        <TextInput
          label="Hasta"
          type="date"
          value={hasta}
          onChange={(event) => setHasta(event.currentTarget.value)}
        />
      </Group>

      {rangoInvalido && (
        <Alert color="red" title="Rango de fechas inválido">
          &quot;Desde&quot; no puede ser posterior a &quot;Hasta&quot;.
        </Alert>
      )}

      {!rangoInvalido && state.status === 'error' && (
        <Alert color="red" title="No se pudieron cargar los resultados">
          {state.message}
        </Alert>
      )}

      {!rangoInvalido && state.status === 'loading' && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {!rangoInvalido && state.status === 'ok' && (
        <>
          <Paper withBorder p="md">
            <Stack gap="xs">
              <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
                <Resumen
                  label="Ventas"
                  value={formatCurrency(state.resumen.ingresos)}
                />
                <Resumen
                  label="Costo de lo vendido"
                  value={formatCurrency(state.resumen.cmv)}
                />
                <Resumen
                  label="Ganancia bruta"
                  value={formatCurrency(state.resumen.margenBruto)}
                />
                <Resumen
                  label="Ganancia bruta %"
                  value={formatPercent(state.resumen.margenBrutoPct)}
                />
                <Resumen
                  label="Gastos"
                  value={formatCurrency(state.resumen.gastos)}
                />
                <Resumen
                  label="Ganancia neta"
                  value={formatCurrency(state.resumen.resultadoNeto)}
                  destacado
                />
              </SimpleGrid>
              <Text size="xs" c="dimmed">
                Calculado el {formatDateTime(state.resumen.calculadoEn)} — una
                anulación posterior puede cambiar este número.
              </Text>
            </Stack>
          </Paper>

          <Grid>
            <Grid.Col span={{ base: 12, md: 7 }}>
              <Paper withBorder p="md">
                <Group justify="space-between" mb="sm">
                  <Title order={5}>Ranking de productos</Title>
                  <SegmentedControl
                    size="xs"
                    value={orden}
                    onChange={setOrden}
                    data={[
                      { label: 'Unidades', value: 'unidades' },
                      { label: 'Ganancia', value: 'margen' },
                    ]}
                  />
                </Group>
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Producto</Table.Th>
                      <Table.Th>Unidades</Table.Th>
                      <Table.Th>Ganancia</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {state.ranking.map((item) => (
                      <Table.Tr key={item.variantId}>
                        <Table.Td>{item.descripcionSnapshot}</Table.Td>
                        <Table.Td>{item.unidadesVendidas}</Table.Td>
                        <Table.Td>{formatCurrency(item.margenTotal)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                {state.ranking.length === 0 && (
                  <Text c="dimmed" ta="center" py="md">
                    Sin ventas en este período.
                  </Text>
                )}
              </Paper>
            </Grid.Col>

            <Grid.Col span={{ base: 12, md: 5 }}>
              <Paper withBorder p="md">
                <Title order={5} mb="sm">
                  Gastos por categoría
                </Title>
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Categoría</Table.Th>
                      <Table.Th>Total</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {state.gastosPorCategoria.map((item) => (
                      <Table.Tr key={item.expenseCategoryId}>
                        <Table.Td>{item.nombre}</Table.Td>
                        <Table.Td>{formatCurrency(item.total)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                {state.gastosPorCategoria.length === 0 && (
                  <Text c="dimmed" ta="center" py="md">
                    Sin gastos en este período.
                  </Text>
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </>
      )}
    </Stack>
  );
}

function Resumen({
  label,
  value,
  destacado = false,
}: {
  label: string;
  value: string;
  destacado?: boolean;
}) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size={destacado ? 'xl' : 'lg'} fw={destacado ? 700 : 500}>
        {value}
      </Text>
    </Stack>
  );
}
