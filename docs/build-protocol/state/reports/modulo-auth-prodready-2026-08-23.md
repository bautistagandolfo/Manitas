# Production Readiness Review — módulo `auth` (2026-08-23)

Fase 12 del protocolo. Fase 11 (re-audit) VERDE, no bloqueada,
verificado en `state/STATUS.md` antes de empezar. Sin código
modificado (regla explícita) — solo tests existentes, lint, build,
análisis estático y revisión de código. Este es el gate de cierre del
módulo: solo si queda VERDE se lo puede considerar aprobado para la
Integration Audit (fase 13).

## Security

- **Authentication/authorization**: `AuthGuard` + `RolesGuard`
  globales (`APP_GUARD`), orden correcto (`AuthGuard` puebla
  `request.user` antes de que `RolesGuard` lo necesite). `/users/*`
  exige `@Roles(OWNER)` a nivel de clase; `/auth/login` y
  `/auth/logout` son las únicas rutas `@Public()`; `/auth/me` exige
  sesión sin rol específico. Verificado extensamente en fases 07-11
  (incluida la corrección de la race condition del último OWNER
  activo, fase 08).
- **Secrets**: `JWT_SECRET` con mínimo de 32 caracteres exigido por
  schema y confirmado con el valor real regenerado en `.env` (fase
  11, sin necesidad de override de entorno). `COOKIE_SECRET` eliminado
  (no se usaba). `.env`/`.env.example` correctamente en `.gitignore`,
  nada trackeado en git. `SEED_OWNER_PASSWORD` exigido por variable de
  entorno, nunca hardcodeado (`prisma/seed.ts`).
- **Data exposure**: `passwordHash` omitido consistentemente
  (`omit: { passwordHash: true }`) en las 4 operaciones que devuelven
  un usuario — verificado con tests dedicados. Mensajes de error
  genéricos en login (no revela si el email existe). JWT de sesión ya
  no aparece en logs en texto plano (fase 10/11, `redact` en
  `pinoHttp`, reconfirmado en la corrida de 43 tests de esta fase: 0
  apariciones sin censurar).

Sin hallazgos nuevos. Los 6 de la auditoría de seguridad (fase 09)
siguen confirmados corregidos (fase 11).

## Reliability

- **Errors**: `GlobalExceptionFilter` normaliza toda excepción a un
  body consistente, nunca expone stack ni detalles internos en la
  respuesta; 5xx se loguean server-side con stack, 4xx no (correcto —
  son errores de cliente esperados, no excepciones).
- **Timeouts** — **hallazgo (MEDIUM, TD-3)**: `frontend/src/lib/http-client.ts`
  no usa `AbortController` ni ningún timeout en sus llamadas `fetch`.
  Si la conexión de la tienda falla a mitad de un login (o cualquier
  otra request), el botón queda en estado "cargando" indefinidamente,
  sin feedback ni forma de cancelar — el único remedio es recargar la
  página. No es un problema de seguridad, es de UX/resiliencia de red,
  relevante para el contexto real de uso (una tienda física, con la
  variabilidad de conectividad que eso implica).
- **Retries**: sin llamadas a servicios externos en este módulo más
  allá de la base de datos (Prisma). El frontend no reintenta logins
  automáticamente — correcto, evita amplificar el rate limit.
- **External failures**: `GET /health` verifica conectividad real a la
  base (`SELECT 1`) y devuelve 503 explícito si falla, sin exponer
  detalles. Si la base cae a mitad de un request normal, el error
  Prisma se traduce a 500 genérico vía `GlobalExceptionFilter` — sin
  fallo silencioso.
- **Estados inconsistentes**: la baja del último OWNER activo usa
  `SELECT ... FOR UPDATE` dentro de una transacción (fase 08) — ya
  verificado 0/30 carreras. Alta de usuario y reset de contraseña
  manejan la violación de unicidad de email (`P2002`) y "no encontrado"
  (`P2025`) explícitamente, sin dejar la base a mitad de camino.

## Performance

- **Queries**: sin N+1 — el modelo `User` no trae relaciones en
  ninguna consulta del módulo.
- **`GET /users` sin paginación** — **hallazgo (LOW, TD-5)**: trae
  todos los usuarios en una sola respuesta. Aceptable para el MVP
  (una sola tienda, decenas de usuarios como mucho), no para una
  escala mayor.
- **argon2 con parámetros por defecto (~64 MiB por operación)** —
  **hallazgo (MEDIUM, TD-4)**: ni `users.service.ts` ni
  `auth.service.ts` pasan `memoryCost`/`timeCost` explícitos a
  `argon2.hash`/`argon2.verify`. El hosting objetivo es gratuito
  (BLUEPRINT §9.10, típicamente ~512MB de RAM en el free tier de
  Render) — una ráfaga real de logins concurrentes (o un intento de
  fuerza bruta que llegue al límite de 20/min desde varias IPs a la
  vez) podría presionar la memoria de una instancia así. El rate limit
  de login ya lo acota bastante, y la concurrencia esperada para una
  sola tienda es baja, así que no bloquea — pero es un límite de
  memoria concreto que vale la pena tener anotado antes de elegir el
  plan de hosting final.
- **Memory**: sin caches ni loops sin cota en el código del módulo.
- **Slow endpoints**: el login es lento a propósito (argon2 corre
  siempre, incluso con email inexistente, por diseño anti-timing) —
  mitigado por el rate limit de la fase 08.

## Code quality

- **Architecture**: sigue las convenciones de Nest del resto del
  repo (controller/service/DTO separados, guards y decorators en
  `common/auth/`). Consistente con `module-auth-spec.md`.
- **Duplication**: baja — constantes compartidas extraídas donde
  correspondía (`ACCESS_TOKEN_COOKIE`, `LOGIN_THROTTLE`,
  `LOG_REDACT_PATHS`) en vez de repetidas.
- **Complexity**: `UsersService.update()` tiene la rama necesaria para
  proteger al último OWNER activo — comentada explicando el porqué,
  cubierta por tests unitarios y de integración (incluida la
  regresión de concurrencia).
- **Maintainability**: sin TODOs/FIXME/HACK en el código del módulo
  (backend ni frontend). Comentarios explican decisiones no obvias
  (por qué 20/min, por qué `SafeUser` vs `SafeAuthUser`, por qué
  `app.disable('x-powered-by')` y no un middleware) sin describir lo
  obvio.
- **`AuthContext.tsx` exporta componente + hook desde el mismo
  archivo** — **hallazgo (LOW, TD-6)**: ESLint marca
  `react-refresh/only-export-components` (warning, no error).
  Cosmético, sin impacto funcional.
- **`package.json#prisma` deprecado** — **hallazgo (LOW, TD-7)**:
  Prisma pide migrar a `prisma.config.ts` antes de la v7. El proyecto
  fija Prisma por debajo de la v7 a propósito (v7 es ESM-only), así
  que no es urgente.
- **`TD-2` (coverageThreshold de Jest) vencido**: quedó registrado en
  la fase 00 con la condición "se agrega en la fase 07 cuando exista
  el primer `*.service.ts`" — esa fase ya pasó, `users.service.ts` y
  `auth.service.ts` existen (y tienen buena cobertura real, ver más
  abajo). Falta una decisión: configurar el umbral ahora, o
  re-aceptar la deferral con motivo y fecha nuevos. Anotado en
  `TECH_DEBT.md` junto al resto.

## Observability

- **Logs**: `nestjs-pino` con nivel configurable por entorno, formato
  legible en desarrollo (`pino-pretty`) y JSON estructurado en el
  resto. `redact` cubre `cookie` del request y `Set-Cookie` de la
  respuesta (fase 10/11) — reconfirmado en esta fase con la corrida
  completa de integración: 0 tokens en texto plano.
- **Información útil para debug**: cada log de request incluye id,
  método, url, tiempo de respuesta y status; las respuestas de error
  llevan `statusCode`, `timestamp`, `path` y `message` de forma
  consistente. Los 5xx quedan con stack trace en el log del server
  (nunca en la respuesta HTTP).

## Deployment

- **Environment variables**: `env.schema.ts` valida todo lo que el
  módulo necesita (`JWT_SECRET`, `DATABASE_URL`, `FRONTEND_URL`,
  `NODE_ENV`, `LOG_LEVEL`) con defaults sensatos para lo no crítico y
  falla rápido y explícito si falta algo. Confirmado funcionando
  contra el `.env` real de desarrollo (fase 11).
- **Migrations**: `npx prisma migrate status` → *"Database schema is
  up to date"*. Sin migraciones pendientes relacionadas a este módulo.
- **Configuration**: CORS restringido a un único origin configurado
  (sin reflejar el `Origin` del request, verificado en fases 09/11);
  cookie de sesión con `SameSite`/`Secure` correctos según entorno.
  Sin `connection_limit` explícito en `DATABASE_URL` — Prisma usa su
  pool por defecto; no se identificó problema concreto a esta escala,
  pero vale tenerlo en cuenta al elegir el proveedor de base final
  (Neon, según BLUEPRINT §9.10).
- **Build**: backend (`nest build`) y frontend (`tsc -b && vite
  build`) verdes.

## Tests ejecutados

- Backend unitarios: **29/29** verde (`npm run test`).
- Backend integración: **43/43** verde (`npm run test:integration`,
  corrida completa contra Postgres real).
- Frontend build: verde.
- Lint backend: verde. Lint frontend: verde (1 warning cosmético, ver
  TD-6).
- Cobertura (`npm run test:cov`, solo unitarios): `users.service.ts`
  91%, `auth.service.ts` 90%, guards 100%. Los números bajos en
  controllers/DTOs/decorators (0% en la corrida unitaria) **no son un
  hueco real** — ese código lo cubren los tests de integración
  (supertest contra HTTP real), no los unitarios; la estrategia de
  testing del repo separa unit (servicios, Prisma mockeado) de
  integración (controllers/guards/DTOs, HTTP real) a propósito.
- `npx prisma migrate status`: sin pendientes.

---

```
PRODUCTION READY: YES

CRITICAL ISSUES: ninguno
HIGH ISSUES: ninguno
MEDIUM ISSUES: 2 — TD-3 (sin timeout en fetch del frontend, UX de red
  colgada) y TD-4 (argon2 con memoria por defecto, riesgo de RAM en
  hosting gratuito bajo ráfaga concurrente) — ninguno bloquea, ambos
  registrados en TECH_DEBT.md
LOW ISSUES: 3 nuevos (TD-5 sin paginación en GET /users, TD-6 warning
  cosmético de ESLint en AuthContext.tsx, TD-7 config de Prisma
  deprecada) + 1 vencido y re-señalado (TD-2, coverageThreshold de
  Jest) — todos registrados en TECH_DEBT.md

TEST RESULTS: 29/29 unitarios, 43/43 integración, lint y build (backend
  y frontend) en verde
SECURITY RESULTS: sin hallazgos nuevos; los 6 de la fase 09 confirmados
  corregidos en la fase 11 con evidencia empírica, reconfirmado acá
PERFORMANCE RESULTS: sin N+1 ni queries problemáticas; 2 riesgos MEDIUM
  documentados (ver arriba), ninguno bloqueante a la escala del MVP
REMAINING RISKS: los 5 ítems de TECH_DEBT.md (TD-2 vencido, TD-3, TD-4,
  TD-5, TD-6, TD-7) — todos MEDIUM/LOW, ninguno de seguridad,
  ninguno bloquea el Quality Gate por regla de QUALITY_GATE.md
```

**Aplicando las reglas de bloqueo de `QUALITY_GATE.md`**: sin CRITICAL,
sin HIGH que afecte seguridad/autenticación/autorización/dinero/stock/
integridad de datos — nada bloquea automáticamente. Los MEDIUM/LOW
quedan documentados en `state/TECH_DEBT.md` como pide la sección
"Deuda técnica" del gate.

**El módulo `auth` queda aprobado para la Integration Audit (fase
13).**
