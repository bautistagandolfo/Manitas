# Production Readiness Review — módulo `cash-registers` (2026-08-24)

Fase 12 del protocolo, gate de cierre del módulo. **Sin código
modificado** (regla de la fase — "NO CORRIJAS NADA"). Alcance:
T3.1–T3.7, fases 07–11 ya en VERDE. Todo lo de abajo se corrió de
nuevo en esta fase, no reciclado de reportes anteriores.

---

## Security

- **Authentication/authorization**: `AuthGuard`/`RolesGuard` globales
  cubren las 5 rutas del módulo; matriz de permisos contrastada contra
  la spec sin discrepancias (fase 09, reconfirmado en vivo en fase
  11). `POST /movements/ingreso`/`retiro` — `OWNER`-only real
  (`@Roles`), verificado con 401/403 reales en fases anteriores.
- **Secrets**: el módulo no maneja ni referencia ninguno.
- **Data exposure**: RN-6 (cierre a ciegas) — `montoSistema`/
  `diferencia` genuinamente ausentes del JSON para SELLER, no `null`.
  Reconfirmado en la fase 11 con los 12 tests de integración
  correspondientes, re-corridos de nuevo ahora sin cambios (ver
  "Test results" abajo).
- Sin CRITICAL ni HIGH en ninguna de las fases 08–11. 2 LOW
  documentadas (TD-11, TD-12), ninguna bloqueante según
  `QUALITY_GATE.md`.

## Reliability

- **Errores**: todo pasa por `GlobalExceptionFilter`, normalizado a
  `{statusCode, timestamp, path, message}` — sin stack traces ni
  detalle interno expuesto (confirmado en fase 08/09, incluidos los
  dos casos que antes tiraban 500 crudo, ya corregidos).
- **Estados inconsistentes**: la carrera movimiento-vs-cierre
  (sección 5 de la spec) está protegida con `SELECT...FOR UPDATE`
  sobre la fila de sesión en ambos métodos, probada empíricamente con
  10 iteraciones de concurrencia real (fase 07) — sigue en verde.
  El rechazo de RN-5 (nota faltante) ocurre antes de cualquier
  escritura, sin dejar la sesión a medio cerrar.
- **Timeouts/retries/fallos externos**: el módulo no agrega ninguna
  lógica propia acá — hereda el comportamiento de Prisma/Postgres del
  resto del sistema (mismo perfil que `auth`/`products`, ya evaluado
  en sus propias fases 12; no es un gap nuevo de este módulo). Sin
  reintentos automáticos en ningún lado — correcto por diseño: un
  movimiento de caja NUNCA debería reintentarse solo, es
  `Idempotency-Key` (T0.14) quien resuelve el "doble click", no un
  retry ciego que podría duplicar sin esa protección.

## Performance

- **Queries por request**: cada endpoint HTTP hace un número fijo y
  chico de queries (1 a 3) — sin loops que llamen a Prisma por ítem,
  sin patrón N+1 en ningún método (`grep` de `findMany`/`findFirst`/
  `aggregate`/`groupBy` en todo el servicio: 5 llamadas totales, todas
  fuera de cualquier loop).
- **`reconciliar()` sin paginar**: escanea TODAS las sesiones
  `CERRADA` y agrupa TODOS los `cash_movements` de una vez
  (`findMany`/`groupBy` sin `take`/`skip`). Mismo criterio que TD-5
  (`GET /users` sin paginar): a escala de una sola tienda el volumen
  es bajo, y — a diferencia de `GET /users` — **este método no está
  expuesto por ningún endpoint HTTP** (confirmado: sin match en
  `cash-registers.controller.ts`), es una función de mantenimiento
  interna (invocada a mano o por test), no una ruta que un usuario
  real dispare. No se registra como TD nuevo por ese motivo — el
  riesgo real es menor que el de `GET /users`, que sí es una ruta
  pública del sistema.
- **Bundle frontend**: TD-10 (611 kB/187 kB gzip) sigue igual, no
  empeoró con este módulo específicamente (las 4 pantallas de
  `cash-registers` son un incremento chico comparadas con las de
  `products`, que fue donde se notó por primera vez).

## Code quality

- **Arquitectura**: separación DTO → controller (delgado, abre la
  transacción) → service (lógica de negocio) consistente con
  `auth`/`products`. `registrarMovimientoManual` reutiliza
  `registrarMovimiento` sin duplicar lógica de signo/lock.
- **Duplicación**: ninguna dentro del módulo (revisado en fase 07).
  La función `assertDentroDePrecision()` agregada en la fase 08 es
  local al módulo — no se unificó con `common/money/` a propósito
  (mismo criterio que otros chequeos puntuales del sistema, ej. el
  mensaje rico de `prices.service.ts` que tampoco se unificó).
- **Complejidad**: el método más largo (`cerrarSesion`) tiene
  validación → lock → cálculo → decisión de nota → escritura, en ese
  orden lineal, sin ramas anidadas más allá de un nivel. Sin
  `TODO`/`FIXME`/código muerto en el módulo (backend ni frontend,
  reconfirmado con `grep` ahora).
- **Mantenibilidad**: cobertura de mutación 98.55% (fase 08) es una
  señal fuerte de que los tests realmente documentan el
  comportamiento esperado, no solo lo ejercitan.

## Observability

- Sin logging propio del módulo (ningún `Logger`/`console.*` en
  `cash-registers/`) — mismo perfil que el resto del sistema, que
  confía en `pinoHttp` (logging automático de cada request:
  método, ruta, status, tiempo de respuesta) más el
  `GlobalExceptionFilter` para errores. No es un gap nuevo: ningún
  otro módulo (`auth`, `products`, `stock`) tiene logging propio
  tampoco.
- Los mensajes de error del servicio (`"La sesión de caja ya está
  cerrada"`, `"La diferencia es de $N..."`, etc.) son lo
  suficientemente específicos como para diagnosticar un problema real
  sin necesitar logs adicionales — confirmado leyendo la tabla de
  errores de la spec (sección 7), todos implementados tal cual.

## Deployment

- **Variables de entorno**: el módulo no agrega ninguna nueva — usa
  la configuración de base de datos ya validada globalmente
  (`env.schema.ts`).
- **Migraciones**: `npx prisma migrate status` → "Database schema is
  up to date" (2 migraciones del módulo:
  `cash_register_sessions_one_open_key`/`cash_movements_monto_sign_check`
  desde la fase 01, y `cash_movements_immutable_after_close` de T3.2).
- **Build**: backend (`nest build`) y frontend (`tsc -b && vite
  build`) verdes, sin warnings nuevos más allá de los ya documentados
  (TD-7 deprecación de `package.json#prisma`, TD-10 tamaño de bundle).

---

## Test results

Corridos de nuevo en esta fase, no reciclados:

- Backend unitarios: **242/242** verde (incluye los 53 de
  `cash-register.service.spec.ts`).
- Backend integración: **209/209** verde, **3 corridas seguidas sin
  flakes**.
- Frontend Vitest: **31/31** verde.
- Cobertura de `cash-register.service.ts` (solo unitarios): **100%
  statements/lines/functions, 88.46% branches** — las líneas sin
  cubrir (136, 339, 404-412) son las mismas que quedaron
  documentadas como aceptadas en la fase 08 (el contenido literal de
  los `$queryRaw` de lock, y una rama de `reconciliar()` sin ejercicio
  directo por unitarios — cubierta igual por integración).
- Migraciones: al día, sin pendientes.

## Security results

Sin CRITICAL ni HIGH en ninguna fase de seguridad (08/09/10/11). 2 LOW
documentadas y aceptadas (TD-11, TD-12) — ninguna bloquea el Quality
Gate.

## Performance results

Sin N+1 en ningún endpoint HTTP. Un método interno sin paginar
(`reconciliar()`, no expuesto por HTTP) — riesgo bajo, no bloqueante.
Bundle frontend con el warning preexistente de tamaño (TD-10),
inalterado por este módulo.

## Remaining risks

- **TD-11** (LOW) — `Idempotency-Key` sin cota de longitud,
  infraestructura compartida fuera de este módulo.
- **TD-12** (LOW) — sin rate limiting en movimientos manuales,
  consistente con el resto del sistema.
- **Gaps de alcance ya señalados en la fase 07, sin ticket propio
  todavía**: `GET /sessions/:id`, `GET /sessions/:id/movements`, y la
  vía para que un OWNER complete `nota_cierre` después de un cierre
  de SELLER con diferencia sin explicar. Ninguno bloquea el uso real
  del módulo hoy (la única pantalla existente, `CashRegisterPage.tsx`,
  no los necesita), pero son funcionalidad de la spec original sin
  construir — quedan para una decisión explícita, no para esta fase.
- Los MEDIUM ya existentes de `auth` (TD-3, sin timeout de fetch en
  el frontend; TD-4, parámetros por defecto de `argon2`) siguen
  aplicando de forma transversal a todo el sistema, incluido este
  módulo — no son hallazgos nuevos de `cash-registers`.

---

```
PRODUCTION READY: YES

CRITICAL ISSUES: 0
HIGH ISSUES: 0
MEDIUM ISSUES: 0 nuevos (TD-3/TD-4 de auth siguen aplicando de forma transversal, no son de este módulo)
LOW ISSUES: 2 nuevas de este módulo (TD-11, TD-12), más TD-7/TD-9/TD-10 transversales ya conocidas

TEST RESULTS: 242/242 unitarios, 209/209 integración (x3 sin flakes), 31/31 frontend — todo verde
SECURITY RESULTS: sin CRITICAL/HIGH en fases 08-11; RN-6 (cierre a ciegas) reconfirmado empíricamente
PERFORMANCE RESULTS: sin N+1 en rutas HTTP; reconciliar() sin paginar pero no expuesto por HTTP, riesgo bajo
REMAINING RISKS: TD-11, TD-12 (LOW, este módulo); 2 endpoints GET documentados en la spec sin ticket que los construya; TD-3/TD-4 transversales de auth
```

**Módulo `cash-registers` aprobado — pasa a la fase 13 (Integration
Audit).**
