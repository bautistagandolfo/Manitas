import { Alert, Stack } from '@mantine/core';
import { Outlet } from 'react-router-dom';
import { useAuth } from './AuthContext';

// Defensa en profundidad para pantallas que siempre involucran costo
// (grilla, alta de variante suelta): BLUEPRINT §12.6 — "el vendedor nunca
// ve, en ninguna pantalla, costos ni resultados". El backend ya rechaza
// estas rutas con 403 para SELLER (AMB-11); esto evita que el formulario
// con campos de costo llegue a pintarse si alguien entra por URL directa.
export function RequireOwner() {
  const { user } = useAuth();

  if (user?.rol !== 'OWNER') {
    return (
      <Stack p="md">
        <Alert color="red" title="Acceso restringido">
          Esta sección es solo para el dueño de la tienda.
        </Alert>
      </Stack>
    );
  }

  return <Outlet />;
}
