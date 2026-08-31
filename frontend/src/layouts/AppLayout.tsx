import { useState } from 'react';
import {
  AppShell,
  Badge,
  Box,
  Button,
  Group,
  Text,
  Title,
} from '@mantine/core';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

// Shell de navegación de toda la app autenticada (T2.12) — reemplaza al
// HomePage placeholder de T0.5. El nombre del usuario y "Cerrar sesión"
// viven acá, visibles siempre, en vez de repetirse por pantalla.
//
// Ticket nuevo (post Release Candidate) — hallazgo real reportado por
// el usuario ("el diseño principal quedó raro, owner y cerrar sesión
// quedaron medio raros"): con hasta 9 links (6 comunes + 3 de OWNER)
// más el nombre/rol/logout, todo en una sola fila de 60px de alto no
// entraba — el `Group` con `justify="space-between"` los envolvía a
// una segunda línea que el `AppShell.Header` de altura fija no podía
// acomodar, dejando "Owner · DUEÑO · Cerrar sesión" flotando de forma
// desprolija. Se separa en dos filas a propósito, cada una con su
// propio propósito (identidad arriba, navegación abajo) — patrón
// estándar de panel de administración, nunca compite por el mismo
// espacio horizontal.
export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const isOwner = user?.rol === 'OWNER';

  const handleLogout = async (): Promise<void> => {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
      void navigate('/login', { replace: true });
    }
  };

  return (
    <AppShell header={{ height: 96 }} padding="md">
      <AppShell.Header>
        <Group h={52} px="md" justify="space-between">
          <Title
            order={4}
            component={Link}
            to="/"
            style={{ textDecoration: 'none', color: 'inherit' }}
          >
            Manitas
          </Title>
          <Group gap="sm">
            <Text size="sm">{user?.nombre}</Text>
            {user && (
              <Badge
                variant="light"
                color={user.rol === 'OWNER' ? 'grape' : 'blue'}
              >
                {user.rol === 'OWNER' ? 'Dueño' : 'Vendedor'}
              </Badge>
            )}
            <Button
              variant="light"
              size="xs"
              onClick={() => void handleLogout()}
              loading={loggingOut}
            >
              Cerrar sesión
            </Button>
          </Group>
        </Group>
        <Box
          h={44}
          px="md"
          style={(theme) => ({
            borderTop: `1px solid ${theme.colors.gray[2]}`,
            backgroundColor: theme.colors.gray[0],
          })}
        >
          <Group h="100%" gap="xs">
            <Button component={Link} to="/" variant="subtle" size="sm">
              Inicio
            </Button>
            <Button component={Link} to="/venta" variant="subtle" size="sm">
              Venta
            </Button>
            <Button component={Link} to="/ventas" variant="subtle" size="sm">
              Historial
            </Button>
            <Button
              component={Link}
              to="/devoluciones"
              variant="subtle"
              size="sm"
            >
              Devoluciones
            </Button>
            <Button component={Link} to="/caja" variant="subtle" size="sm">
              Caja
            </Button>
            <Button component={Link} to="/catalogo" variant="subtle" size="sm">
              Catálogo
            </Button>
            {isOwner && (
              <>
                <Button
                  component={Link}
                  to="/gastos"
                  variant="subtle"
                  size="sm"
                >
                  Gastos
                </Button>
                <Button
                  component={Link}
                  to="/resultados"
                  variant="subtle"
                  size="sm"
                >
                  Resultados
                </Button>
                <Button
                  component={Link}
                  to="/configuracion"
                  variant="subtle"
                  size="sm"
                >
                  Configuración
                </Button>
              </>
            )}
          </Group>
        </Box>
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
