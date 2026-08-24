import { useState } from 'react';
import { AppShell, Badge, Button, Group, Text, Title } from '@mantine/core';
import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

// Shell de navegación de toda la app autenticada (T2.12) — reemplaza al
// HomePage placeholder de T0.5. El nombre del usuario y "Cerrar sesión"
// viven acá, visibles siempre, en vez de repetirse por pantalla.
export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);

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
    <AppShell header={{ height: 60 }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="lg">
            <Title order={4}>Manitas</Title>
            <Button component={Link} to="/caja" variant="subtle">
              Caja
            </Button>
            <Button component={Link} to="/catalogo" variant="subtle">
              Catálogo
            </Button>
          </Group>
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
      </AppShell.Header>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
