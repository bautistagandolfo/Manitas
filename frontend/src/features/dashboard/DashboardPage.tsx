import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Center,
  Group,
  Loader,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../../lib/http-client';
import { formatCurrency, formatDateTime } from '../../lib/format';
import { getOpenSession } from '../cash-registers/api';
import type { CashRegisterSession } from '../cash-registers/types';
import { getResultados } from '../expenses/api';
import type { ResultadosResumen } from '../expenses/types';

type SessionState =
  | { status: 'loading' }
  | { status: 'sin-sesion' }
  | { status: 'abierta'; session: CashRegisterSession }
  | { status: 'error'; message: string };

// Mismo criterio que `ResultadosPage.tsx`: "hoy" sale de `new Date()`
// del cliente (se asume la terminal en hora argentina, mismo supuesto
// que cualquier otro selector de fecha de la app), no del backend.
function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

interface QuickAction {
  to: string;
  label: string;
  description: string;
  destacada?: boolean;
}

// Ticket nuevo (post Release Candidate) — hallazgo real reportado por
// el usuario: esta grilla repetía casi uno a uno toda la barra de
// navegación (8 de sus 9 links) — no funcionaba como "acceso rápido a
// lo más usado", era simplemente la nav de nuevo, más grande. Se
// recorta a propósito a lo que se toca todos los días en el flujo real
// de una vendedora (vender, y la caja que hay que abrir antes de poder
// vender) más devoluciones/cambios, que son frecuentes en indumentaria
// — nunca se saca nada de la barra de navegación de arriba
// (`AppLayout.tsx`), que sigue siendo el camino a TODO, esto es solo
// el atajo a lo más común.
const ACCIONES_COMUNES: QuickAction[] = [
  {
    to: '/venta',
    label: 'Vender',
    description: 'Registrar una venta nueva',
    destacada: true,
  },
  { to: '/caja', label: 'Caja', description: 'Abrir, cerrar o mover efectivo' },
  {
    to: '/devoluciones',
    label: 'Devoluciones',
    description: 'Buscar una venta y procesar una devolución o cambio',
  },
];

// RN-2/RN-11: resultados revela plata del negocio — mismo gate que ya
// usa `router.tsx` (`RequireOwner`). Es el único agregado para OWNER:
// un vistazo rápido a "cómo viene el negocio" es lo más natural para
// abrir en una pantalla de inicio — gastos/configuración se tocan con
// mucha menos frecuencia, quedan solo en la barra de navegación.
const ACCIONES_OWNER: QuickAction[] = [
  {
    to: '/resultados',
    label: 'Resultados',
    description: 'Ingresos, márgenes y ranking de productos',
  },
];

// Ticket nuevo (post Release Candidate) — pantalla de inicio con
// accesos rápidos a lo que se usa todos los días, más el estado de la
// caja (relevante para cualquier rol: sin caja abierta no se puede
// vender) y, solo para OWNER, un resumen financiero del día
// (RN-2/RN-11: SELLER nunca ve costo/margen/resultado neto — acá
// directamente no se pide el dato, no se pide y se esconde).
export function DashboardPage() {
  const { user } = useAuth();
  const isOwner = user?.rol === 'OWNER';

  const [sessionState, setSessionState] = useState<SessionState>({
    status: 'loading',
  });
  const [resumen, setResumen] = useState<ResultadosResumen | null>(null);
  const [resumenError, setResumenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getOpenSession()
      .then((session) => {
        if (!cancelled) setSessionState({ status: 'abierta', session });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setSessionState({ status: 'sin-sesion' });
        } else {
          setSessionState({
            status: 'error',
            message:
              err instanceof ApiError
                ? err.message
                : 'No se pudo cargar el estado de la caja.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    const hoy = toIsoDate(new Date());
    getResultados(hoy, hoy)
      .then((data) => {
        if (!cancelled) setResumen(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setResumenError(
            err instanceof ApiError
              ? err.message
              : 'No se pudo cargar el resumen de hoy.',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOwner]);

  const acciones = isOwner
    ? [...ACCIONES_COMUNES, ...ACCIONES_OWNER]
    : ACCIONES_COMUNES;

  return (
    <Stack>
      <Title order={3}>Inicio</Title>

      {sessionState.status === 'loading' && (
        <Center py="md">
          <Loader size="sm" />
        </Center>
      )}

      {sessionState.status === 'error' && (
        <Alert color="red" title="No se pudo cargar el estado de la caja">
          {sessionState.message}
        </Alert>
      )}

      {sessionState.status === 'sin-sesion' && (
        <Alert color="yellow" title="No hay una caja abierta">
          <Stack gap="xs">
            <Text size="sm">Antes de vender hace falta abrir la caja.</Text>
            <Button component={Link} to="/caja" size="xs" w="fit-content">
              Abrir caja
            </Button>
          </Stack>
        </Alert>
      )}

      {sessionState.status === 'abierta' && (
        <Card withBorder>
          <Group justify="space-between">
            <Stack gap={0}>
              <Text fw={700}>Caja abierta</Text>
              <Text size="sm" c="dimmed">
                Desde {formatDateTime(sessionState.session.fechaApertura)}
              </Text>
            </Stack>
            {isOwner && sessionState.session.montoSistema != null && (
              <Stack gap={0} align="flex-end">
                <Text size="sm" c="dimmed">
                  Monto en sistema (en vivo)
                </Text>
                <Text fw={700}>
                  {formatCurrency(sessionState.session.montoSistema)}
                </Text>
              </Stack>
            )}
          </Group>
        </Card>
      )}

      {isOwner && (
        <Card withBorder>
          <Title order={5} mb="xs">
            Resumen de hoy
          </Title>
          {resumenError && (
            <Text size="sm" c="red">
              {resumenError}
            </Text>
          )}
          {!resumenError && !resumen && (
            <Center py="xs">
              <Loader size="sm" />
            </Center>
          )}
          {resumen && (
            <Group gap="xl">
              <Stack gap={0}>
                <Text size="sm" c="dimmed">
                  Ventas
                </Text>
                <Text fw={700}>{formatCurrency(resumen.ingresos)}</Text>
              </Stack>
              <Stack gap={0}>
                <Text size="sm" c="dimmed">
                  Ganancia bruta
                </Text>
                <Text fw={700}>{formatCurrency(resumen.margenBruto)}</Text>
              </Stack>
              <Stack gap={0}>
                <Text size="sm" c="dimmed">
                  Ganancia neta
                </Text>
                <Text fw={700}>{formatCurrency(resumen.resultadoNeto)}</Text>
              </Stack>
            </Group>
          )}
        </Card>
      )}

      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
        {acciones.map((accion) => (
          <Card
            key={accion.to}
            component={Link}
            to={accion.to}
            withBorder
            padding="lg"
            bg={accion.destacada ? 'blue.0' : undefined}
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            <Text fw={700} size="lg">
              {accion.label}
            </Text>
            <Text size="sm" c="dimmed">
              {accion.description}
            </Text>
          </Card>
        ))}
      </SimpleGrid>
    </Stack>
  );
}
