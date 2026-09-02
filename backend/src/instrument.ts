// Ticket nuevo (post Release Candidate, BLUEPRINT §9.10/A9) — "Sentry (plan
// gratuito) para errores del backend y del frontend... se configura antes
// de salir a producción". Tiene que importarse ANTES que cualquier otra
// cosa en `main.ts` (requisito de la SDK de Sentry, para poder
// instrumentar todo lo que se importe después).
//
// `SENTRY_DSN` es opcional a propósito (no está en `env.schema.ts`, que
// falla rápido si falta algo): en desarrollo y en CI no hace falta tener
// Sentry configurado para nada, y la propia SDK no manda nada si el DSN
// viene undefined — no hace falta un `if` acá.
import * as Sentry from '@sentry/nestjs';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV,
});
