import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Center,
  Paper,
  PasswordInput,
  Stack,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { ApiError } from '../../lib/http-client';
import { useAuth } from './AuthContext';

interface LoginFormValues {
  email: string;
  password: string;
}

// Ticket nuevo (post Release Candidate) — decisión explícita del usuario,
// apartándose a propósito de BLUEPRINT §5.1 ("Login con email y
// contraseña"): un usuario simple, sin exigir forma de email. El campo
// interno sigue llamándose `email` (contrato con el backend, `login.dto.ts`
// — nunca fue un email real, era puramente un identificador de login con
// esa forma).
export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const form = useForm<LoginFormValues>({
    initialValues: { email: '', password: '' },
    validate: {
      email: (value) => (value.trim().length > 0 ? null : 'Ingresá tu usuario'),
      password: (value) => (value.length > 0 ? null : 'Ingresá tu contraseña'),
    },
  });

  const handleSubmit = form.onSubmit(async (values) => {
    setError(null);
    setSubmitting(true);

    try {
      await login(values.email, values.password);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      void navigate(from, { replace: true });
    } catch (err) {
      // Mensaje del backend ya pensado para alguien que no programa
      // (module-auth-spec.md, sección 7) — se muestra tal cual.
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se pudo iniciar sesión. Probá de nuevo.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Center h="100vh">
      <Paper withBorder shadow="sm" p="xl" w={360}>
        <Stack>
          <Title order={2} ta="center">
            Manitas
          </Title>
          <form onSubmit={handleSubmit}>
            <Stack>
              {error && (
                <Alert color="red" title="No se pudo ingresar">
                  {error}
                </Alert>
              )}
              <TextInput
                label="Usuario"
                placeholder="Ej: estefa"
                disabled={submitting}
                {...form.getInputProps('email')}
              />
              <PasswordInput
                label="Contraseña"
                disabled={submitting}
                {...form.getInputProps('password')}
              />
              <Button type="submit" loading={submitting} fullWidth>
                Ingresar
              </Button>
            </Stack>
          </form>
        </Stack>
      </Paper>
    </Center>
  );
}
