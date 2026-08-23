import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Stack, Text } from '@mantine/core';
import { useAuth } from '../features/auth/AuthContext';

export function HomePage() {
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
    <Stack p="md">
      <Text>Hola, {user?.nombre}</Text>
      <Button onClick={() => void handleLogout()} loading={loggingOut} w={200}>
        Cerrar sesión
      </Button>
    </Stack>
  );
}
