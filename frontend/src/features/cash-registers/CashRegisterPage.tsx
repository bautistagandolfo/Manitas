import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Center,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../../lib/http-client';
import { formatCurrency, formatDate, formatDateTime } from '../../lib/format';
import { getOpenSession } from './api';
import type { CashRegisterSession } from './types';
import { OpenSessionForm } from './components/OpenSessionForm';
import { ManualMovementModal } from './components/ManualMovementModal';
import { CloseSessionModal } from './components/CloseSessionModal';

type PageState =
  | { status: 'loading' }
  | { status: 'sin-sesion' }
  | { status: 'abierta'; session: CashRegisterSession }
  | { status: 'error'; message: string };

// T3.7 — pantalla única de caja: qué mostrar depende enteramente de si
// hay una sesión ABIERTA (T3.5, GET /sessions/open) y, si la hay, de si
// es de hoy o quedó olvidada de un día anterior (RN-7, comparación en
// hora argentina vía formatDate — el backend nunca hace esa comparación,
// solo expone fechaApertura).
export function CashRegisterPage() {
  const { user } = useAuth();
  const isOwner = user?.rol === 'OWNER';
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [movementModal, setMovementModal] = useState<
    'INGRESO_MANUAL' | 'RETIRO' | null
  >(null);
  const [closing, setClosing] = useState(false);

  // `loadSession` la usan los botones ("Reintentar", después de cerrar un
  // modal) — ahí sí puede llamarse directo, un handler de evento no es un
  // efecto.
  const loadSession = useCallback(async () => {
    try {
      const session = await getOpenSession();
      setState({ status: 'abierta', session });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ status: 'sin-sesion' });
      } else {
        setState({
          status: 'error',
          message:
            err instanceof ApiError
              ? err.message
              : 'No se pudo cargar el estado de la caja.',
        });
      }
    }
  }, []);

  // La carga inicial NO reusa `loadSession()` — llamar una función async
  // que hace `setState` desde adentro de un `useEffect` dispara el lint
  // `react-hooks/set-state-in-effect`. Mismo patrón que
  // `AuthContext.tsx` (GET /auth/me al montar): una cadena de promesas
  // inline, con una bandera `cancelled` para no pisar el estado si el
  // componente se desmonta antes de que la respuesta llegue.
  useEffect(() => {
    let cancelled = false;

    getOpenSession()
      .then((session) => {
        if (!cancelled) setState({ status: 'abierta', session });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ status: 'sin-sesion' });
        } else {
          setState({
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

  if (state.status === 'loading') {
    return (
      <Center h={200}>
        <Loader />
      </Center>
    );
  }

  if (state.status === 'error') {
    return (
      <Stack maw={480}>
        <Alert color="red" title="No se pudo cargar la caja">
          {state.message}
        </Alert>
        <Button variant="light" onClick={() => void loadSession()}>
          Reintentar
        </Button>
      </Stack>
    );
  }

  if (state.status === 'sin-sesion') {
    // No usa la fila que devuelve el POST directo: `abrirSesion` (T3.1)
    // devuelve la fila recién creada tal cual, sin `montoSistema`
    // recalculado — ese cálculo en vivo es de `GET /sessions/open`
    // (T3.5). Recargar acá evita mostrar "sin monto en sistema" apenas
    // se abre, cuando en realidad ya es igual a `montoInicial`.
    return <OpenSessionForm onOpened={() => void loadSession()} />;
  }

  const { session } = state;
  // RN-7 (§5.5): "no se cierra sola" — el frontend solo detecta y avisa,
  // nunca cierra la sesión por su cuenta.
  const esOlvidada =
    formatDate(session.fechaApertura) !== formatDate(new Date());

  return (
    <Stack maw={560}>
      <Title order={3}>Caja</Title>

      {esOlvidada && (
        <Alert color="yellow" title="Sesión de caja olvidada">
          Esta caja se abrió el {formatDate(session.fechaApertura)} y sigue
          abierta. Hay que cerrarla antes de seguir operando.
        </Alert>
      )}

      <Paper withBorder p="md">
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Abierta el {formatDateTime(session.fechaApertura)}
          </Text>
          <Text>Monto inicial: {formatCurrency(session.montoInicial)}</Text>
          {isOwner && session.montoSistema != null && (
            <Text>
              Monto en sistema (en vivo): {formatCurrency(session.montoSistema)}
            </Text>
          )}
        </Stack>
      </Paper>

      {!esOlvidada && isOwner && (
        <Group>
          <Button onClick={() => setMovementModal('INGRESO_MANUAL')}>
            Ingreso manual
          </Button>
          <Button
            variant="light"
            color="red"
            onClick={() => setMovementModal('RETIRO')}
          >
            Retiro
          </Button>
        </Group>
      )}

      <Button
        variant={esOlvidada ? 'filled' : 'default'}
        color={esOlvidada ? 'yellow' : undefined}
        onClick={() => setClosing(true)}
        w="fit-content"
      >
        Cerrar caja
      </Button>

      {movementModal && (
        <ManualMovementModal
          tipo={movementModal}
          onClose={() => setMovementModal(null)}
          onSaved={() => {
            setMovementModal(null);
            void loadSession();
          }}
        />
      )}

      {closing && (
        <CloseSessionModal
          session={session}
          isOwner={isOwner}
          onClose={() => setClosing(false)}
          onClosed={() => {
            setClosing(false);
            void loadSession();
          }}
        />
      )}
    </Stack>
  );
}
