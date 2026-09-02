import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import { Button, Stack, Text, Title } from '@mantine/core';
import './index.css';
import App from './App.tsx';

// Ticket nuevo (post Release Candidate, BLUEPRINT §9.10/A9) — "Sentry
// (plan gratuito) para errores del backend y del frontend... se
// configura antes de salir a producción". `VITE_SENTRY_DSN` es opcional
// a propósito: sin él, la SDK no manda nada (mismo criterio que
// `SENTRY_DSN` en el backend) — desarrollo local no lo necesita
// configurado.
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN,
  environment: import.meta.env.MODE,
});

// Sin esto, un error de render en cualquier pantalla deja al usuario con
// una página en blanco sin ninguna pista — inaceptable en un mostrador,
// donde "se rompió y no sé por qué" significa una venta perdida. El
// `ErrorBoundary` de Sentry reporta el error solo (no hace falta
// capturarlo a mano) y muestra este resumen en vez de la pantalla vacía.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={() => (
        <Stack align="center" justify="center" mih="100vh" p="md">
          <Title order={3}>Algo salió mal</Title>
          <Text c="dimmed" ta="center">
            Hubo un error inesperado. Recargá la página para seguir.
          </Text>
          <Button onClick={() => window.location.reload()}>Recargar</Button>
        </Stack>
      )}
    >
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
);
