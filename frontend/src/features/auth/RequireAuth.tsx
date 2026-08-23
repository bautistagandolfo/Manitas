import { Center, Loader } from '@mantine/core';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Ruta layout: envuelve las rutas protegidas. Sin @Roles todavía — es
// autenticación (¿hay sesión?), no autorización por rol (BLUEPRINT §5.1:
// eso lo verifica siempre el servidor, esto es solo UX).
export function RequireAuth() {
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  if (status === 'anonymous') {
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  }

  return <Outlet />;
}
