import { useEffect, useState } from 'react';
import { Alert, Center, Loader, Stack, Title } from '@mantine/core';
import { ApiError } from '../../lib/http-client';
import { getSettings } from './api';
import type { Setting } from './types';
import { SettingField } from './components/SettingField';

// T6.9 — BLUEPRINT §10, los 4 parámetros que la dueña puede cambiar sin
// tocar código. Metadata de presentación fija acá (no la manda el
// backend: son 4 claves conocidas de antemano, no una lista abierta) —
// mismo criterio que hardcodear las 4 filas en vez de armar un
// renderizador genérico para "cualquier setting futuro".
const METADATA: Record<
  string,
  { label: string; descripcion: string; suffix?: string }
> = {
  permitir_venta_sin_stock: {
    label: 'Permitir venta sin stock',
    descripcion:
      'Si está desactivado (default), una venta que dejaría el stock en negativo se rechaza.',
  },
  max_descuento_vendedor_pct: {
    label: 'Descuento máximo del vendedor',
    descripcion:
      'Por encima de este porcentaje, la venta necesita autorización del dueño.',
    suffix: '%',
  },
  dias_plazo_devolucion: {
    label: 'Plazo de devolución',
    descripcion:
      'Días desde la venta durante los que se acepta una devolución.',
    suffix: 'días',
  },
  umbral_diferencia_caja: {
    label: 'Umbral de diferencia de caja',
    descripcion:
      'Diferencia entre el monto declarado y el del sistema a partir de la cual el cierre exige una nota.',
  },
};

// Orden fijo de presentación (no alfabético de `clave`, que mezclaría
// `sales` y `cash-registers` sin criterio) — agrupado por dónde impacta
// cada parámetro, mismo orden que la tabla de BLUEPRINT §10.
const ORDEN_CLAVES = [
  'permitir_venta_sin_stock',
  'max_descuento_vendedor_pct',
  'dias_plazo_devolucion',
  'umbral_diferencia_caja',
];

type Estado =
  | { status: 'loading' }
  | { status: 'ok'; settings: Setting[] }
  | { status: 'error'; message: string };

export function SettingsPage() {
  const [state, setState] = useState<Estado>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    getSettings()
      .then((settings) => {
        if (!cancelled) setState({ status: 'ok', settings });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            message:
              err instanceof ApiError
                ? err.message
                : 'No se pudo cargar la configuración. Probá de nuevo.',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function handleSaved(updated: Setting): void {
    setState((prev) =>
      prev.status === 'ok'
        ? {
            status: 'ok',
            settings: prev.settings.map((s) =>
              s.clave === updated.clave ? updated : s,
            ),
          }
        : prev,
    );
  }

  return (
    <Stack maw={560}>
      <Title order={3}>Configuración</Title>

      {state.status === 'error' && (
        <Alert color="red" title="No se pudo cargar la configuración">
          {state.message}
        </Alert>
      )}

      {state.status === 'loading' && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {state.status === 'ok' &&
        ORDEN_CLAVES.map((clave) => {
          const setting = state.settings.find((s) => s.clave === clave);
          const meta = METADATA[clave];
          if (!setting || !meta) return null;
          return (
            <SettingField
              key={clave}
              setting={setting}
              label={meta.label}
              descripcion={meta.descripcion}
              suffix={meta.suffix}
              onSaved={handleSaved}
            />
          );
        })}
    </Stack>
  );
}
