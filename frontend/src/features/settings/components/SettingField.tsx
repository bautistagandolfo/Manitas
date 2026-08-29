import { useState } from 'react';
import {
  Alert,
  Button,
  Group,
  NumberInput,
  Paper,
  Stack,
  Switch,
  Text,
} from '@mantine/core';
import { ApiError } from '../../../lib/http-client';
import { parseNumberInputValue } from '../../../lib/number-input';
import { formatDateTime } from '../../../lib/format';
import { updateSetting } from '../api';
import type { Setting } from '../types';

interface SettingFieldProps {
  setting: Setting;
  label: string;
  descripcion: string;
  // Solo para BOOL/INT — DECIMAL siempre usa "$ " (es plata).
  suffix?: string;
  onSaved: (updated: Setting) => void;
}

// T6.9 — una fila por parámetro (BLUEPRINT §10). BOOL se guarda al
// tocar el switch (no hace falta un botón de "Guardar" para un toggle
// binario); INT/DECIMAL editan en un campo local con "Guardar" habilitado
// solo cuando el valor cambió — evita mandar un PATCH idéntico al actual.
export function SettingField({
  setting,
  label,
  descripcion,
  suffix,
  onSaved,
}: SettingFieldProps) {
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function guardar(valor: string): Promise<void> {
    setError(null);
    setSaving(true);
    try {
      const updated = await updateSetting(setting.clave, valor);
      onSaved(updated);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo guardar. Probá de nuevo.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Paper withBorder p="md">
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Text fw={500}>{label}</Text>
            <Text size="sm" c="dimmed">
              {descripcion}
            </Text>
          </Stack>
        </Group>

        {error && (
          <Alert color="red" title="No se pudo guardar" py="xs">
            {error}
          </Alert>
        )}

        {setting.tipo === 'BOOL' && (
          <Switch
            checked={setting.valor === 'true'}
            onChange={(event) =>
              void guardar(event.currentTarget.checked ? 'true' : 'false')
            }
            disabled={saving}
            label={setting.valor === 'true' ? 'Activado' : 'Desactivado'}
          />
        )}

        {setting.tipo !== 'BOOL' && (
          <NumberField
            setting={setting}
            suffix={suffix}
            saving={saving}
            onSave={(valor) => void guardar(valor)}
          />
        )}

        <Text size="xs" c="dimmed">
          {setting.updatedByUserId
            ? `Última modificación: ${formatDateTime(setting.updatedAt)}`
            : 'Sin modificar desde la instalación'}
        </Text>
      </Stack>
    </Paper>
  );
}

// INT/DECIMAL comparten el patrón "editar + Guardar habilitado solo si
// cambió" — separado en su propio componente porque necesita su propio
// estado local de borrador, distinto del `checked` inmediato de BOOL.
function NumberField({
  setting,
  suffix,
  saving,
  onSave,
}: {
  setting: Setting;
  suffix?: string;
  saving: boolean;
  onSave: (valor: string) => void;
}) {
  const [draft, setDraft] = useState<number | ''>(Number(setting.valor));

  // Si el valor llega actualizado desde afuera (después de un guardado
  // exitoso, `onSaved` en el padre reemplaza `setting`), sincronizá el
  // borrador — así el campo no queda mostrando lo que el usuario tipeó
  // antes de que la respuesta del servidor confirmara el nuevo valor.
  // Ajuste durante el render (no en un efecto: un `setState` síncrono
  // ahí dispara renders en cascada, `react-hooks/set-state-in-effect`),
  // mismo patrón ya usado en `CatalogPage`/`GastosPage`.
  const [trackedValor, setTrackedValor] = useState(setting.valor);
  if (setting.valor !== trackedValor) {
    setTrackedValor(setting.valor);
    setDraft(Number(setting.valor));
  }

  const isDecimal = setting.tipo === 'DECIMAL';
  const sinCambios = draft === Number(setting.valor);

  return (
    <Group align="flex-end">
      <NumberInput
        decimalScale={isDecimal ? 2 : 0}
        fixedDecimalScale={isDecimal}
        decimalSeparator=","
        thousandSeparator="."
        prefix={isDecimal ? '$ ' : undefined}
        suffix={!isDecimal && suffix ? ` ${suffix}` : undefined}
        min={0}
        disabled={saving}
        value={draft}
        onChange={(value) => setDraft(parseNumberInputValue(value))}
        w={200}
      />
      <Button
        variant="light"
        loading={saving}
        disabled={sinCambios || draft === ''}
        onClick={() => {
          if (typeof draft === 'number') {
            onSave(isDecimal ? draft.toFixed(2) : String(draft));
          }
        }}
      >
        Guardar
      </Button>
    </Group>
  );
}
