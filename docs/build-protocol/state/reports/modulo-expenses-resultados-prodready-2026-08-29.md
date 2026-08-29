# Fase 12 — Production Readiness Review del módulo `expenses` + `resultados`

2026-08-29. Rama `fase12-prodready-expenses-resultados`, sobre Fase 11
VERDE (sin CRITICAL/HIGH/MEDIUM). Sin código modificado — regla de la
fase ("NO CORRIJAS NADA").

## Security

- **Authentication/authorization**: reconfirmado en las Fases 09/11 —
  las 8 rutas del módulo exigen sesión, `@Roles(OWNER)` presente en las
  7 que corresponde (`expenses`/`resultados`/`settings`), ausente
  deliberadamente en `expense-categories` (RN-1, spec sección 2, sin
  exclusión de `SELLER` en BLUEPRINT §5.1). Verificado EN VIVO dos veces
  (Fase 09 y Fase 11), mismo resultado ambas.
- **Secrets**: ningún secreto hardcodeado ni gestionado por este módulo
  — las 4 `Setting` reales son config de negocio (booleanos/enteros/
  decimales), `SettingsService.setValor` ni siquiera acepta un tipo
  libre que pudiera usarse como almacén de un secreto por error.
- **Data exposure**: mensajes de error genéricos, sin stack traces ni
  detalles de Prisma expuestos (confirmado en las 4 fases previas).
  `costoUnitario` (dato de margen sensible) solo llega a rutas
  `OWNER`-only, sin ningún camino donde un `SELLER` lo reciba desde este
  módulo.

Sin CRITICAL, HIGH ni MEDIUM (Fases 09/11). Único hallazgo: TD-16 (LOW,
rate limiting), deuda técnica documentada, no bloquea.

## Reliability

- **Errors**: ningún código de este módulo devuelve 500 para un input
  de usuario inválido (confirmado sistemáticamente en Fase 08/09/11) —
  el propio hallazgo de la Fase 08 (fecha de calendario inválida) fue
  justamente un caso que hubiera dado 500 antes del fix, ya corregido y
  reconfirmado en vivo dos veces desde entonces.
- **Timeouts/external failures**: no aplica — el módulo no hace ninguna
  llamada HTTP saliente ni depende de un servicio externo, todas las
  operaciones son contra Postgres vía Prisma.
- **Retries**: `POST /expenses` es idempotente (`Idempotency-Key`
  obligatorio, `withIdempotency` en el controller) — un reintento de
  red no duplica el gasto ni el movimiento de caja asociado, devuelve
  la fila ya creada. `expense-categories`/`settings` no tienen este
  mecanismo (mismo criterio que el resto del sistema: la idempotencia
  se reserva para operaciones que mueven dinero/stock, no para ABM de
  catálogo/config).
- **Inconsistent states**: `registrarGasto` corre íntegro dentro de la
  transacción abierta por el controller (`$transaction`) — validar
  categoría, verificar/obtener sesión de caja, crear el gasto y
  registrar el movimiento de caja son todos pasos de la MISMA
  transacción; si cualquiera falla después de que el gasto ya se creó
  (ej. `registrarMovimiento` lanza), Postgres revierte todo el bloque,
  el gasto nunca queda persistido sin su movimiento correspondiente —
  mismo patrón estructural ya probado y confiado en `sales`/`returns`/
  `cash-registers` (garantía de la propia base, no lógica de aplicación
  que pudiera tener un bug propio). No hay un test de integración que
  fuerce específicamente esa reversión en `expenses` (sí lo hay, por
  ejemplo, para el camino "sin sesión abierta", que aborta ANTES de
  crear el gasto) — no se considera un gap real dado que es el mismo
  mecanismo transaccional ya verificado en otros módulos, no una
  reimplementación propia.

Sin hallazgos nuevos.

## Performance

- **Queries**: `resultados.consultar`/`rankingProductos`/
  `gastosPorCategoria` usan `findMany`/`aggregate` agrupados por rango
  de fecha, con reducción en JS después de una única consulta por
  tabla — sin N+1 en ningún camino de los 3 servicios (confirmado
  leyendo las 3 services completas).
- **N+1**: ninguno — ni en `expenses.service.ts` (una consulta por
  paso, sin loops con `await` dentro) ni en `resultados.service.ts`
  (agregaciones/`findMany` en `Promise.all`, reducción sobre el
  resultado ya traído, nunca una consulta por fila).
- **Unnecessary operations**: sin duplicación de consultas — la
  Fase 07 ya unificó la única duplicación real encontrada
  (`resolverRango`).
- **Memory**: sin acumulación sin cota — las 3 consultas de
  `resultados` están acotadas por el rango de fechas que pide el
  cliente (mismo patrón ya aceptado en `sales.reconciliar()`).
- **Slow endpoints**: **1 hallazgo LOW, ya esperado — TD-17**
  (`state/TECH_DEBT.md`, nuevo en esta fase): ninguna de las tablas
  `expenses`/`sales`/`sale_items`/`returns`/`return_items` tiene un
  índice explícito sobre `fecha` (confirmado leyendo la migración SQL
  directamente), ni `expenses` sobre `expense_category_id` — las 3
  consultas de `resultados` y el filtro de `GET /expenses` dependen de
  un rango de `fecha` sin índice que lo acote, forzando un sequential
  scan completo en cada consulta. **No bloquea**: es un gap
  pre-existente y transversal a todo el esquema (`sales`/`returns` ya
  pasaron su propia Fase 12 con el mismo patrón sin marcarlo
  bloqueante), y a la escala del MVP (una sola tienda) el volumen de
  filas esperado hace que un sequential scan sea rápido en la
  práctica.

## Code quality

- **Architecture**: 3 services con responsabilidad única y clara
  (`ExpenseCategoriesService` ABM, `ExpensesService` registro +
  vínculo con caja, `ResultadosService` lectura pura agregada) — mismo
  patrón de capas que el resto del backend (`controller` fino →
  `service` con la lógica → Prisma tipado, sin SQL crudo).
- **Duplication**: ninguna nueva desde la Fase 07 (que ya encontró y
  corrigió la única real, `resolverRango`). Confirmado sin regresión —
  las 3 services no crecieron en tamaño desde entonces salvo el fix de
  fecha de la Fase 08 (una función nueva, sin duplicar nada existente).
- **Complexity**: sin funciones largas ni anidamiento excesivo —
  `registrarGasto` es la más larga (validación → categoría → sesión de
  caja opcional → create → movimiento opcional), lineal y comentada
  paso a paso, mismo estilo que `sales`/`returns`.
- **Maintainability**: cobertura de mutación 98.85% (reconfirmada en
  esta fase, sin cambios desde la Fase 08) — los 3 sobrevivientes
  documentados como equivalentes/inalcanzables, no ruido. Sin
  `TODO`/`FIXME`/`XXX` en `src/modules/expenses/`,
  `src/common/timezone/`, `src/common/settings/` (`grep` reconfirmado
  en esta fase).

Sin hallazgos nuevos.

## Observability

- **Logs**: sin logging propio en el módulo — depende del logger HTTP
  global (`pino`), que ya redacta `cookie` y registra método/ruta/
  status/tiempo de respuesta de cada request, consistente con el resto
  del sistema. Un error no controlado (ninguno reproducido en este
  módulo, ver Reliability) igual quedaría visible vía el logger global
  de Nest — no depende de nada específico de `expenses`/`resultados`.
- **Useful debugging information**: los mensajes de error del módulo
  son específicos y accionables ("Esta categoría de gasto está
  desactivada", "No hay una sesión de caja abierta", "El rango de
  fechas no es válido", "Fecha inválida (el día no existe)") — no
  genéricos al punto de no decir qué pasó, mismo criterio ya verbatim
  contra la spec desde la Fase 07.

Sin hallazgos nuevos.

## Deployment

- **Environment variables**: ninguna nueva — `grep` de
  `process.env`/`ConfigService` sobre `src/modules/expenses/` y
  `src/common/settings/`: sin resultados. El módulo no depende de
  ninguna variable de entorno propia.
- **Migrations**: ninguna nueva en toda la Etapa 6 — `Expense`/
  `ExpenseCategory`/`Setting` ya existían en el esquema desde antes
  (confirmado: `ls prisma/migrations` no tiene ninguna migración nueva
  posterior a las ya existentes al arrancar T6.1).
- **Configuration**: sin configuración nueva fuera de las 4 `Setting`
  ya seedeadas desde T0.13 — este módulo solo agrega la ruta HTTP para
  administrarlas (`GET`/`PATCH /settings`), no agrega parámetros
  nuevos.
- **Build**: backend (`nest build`) y frontend (`tsc -b && vite build`)
  limpios — bundle frontend 684.48 kB / 205.89 kB gzip, idéntico al ya
  reportado al cierre de T6.9 (sin crecimiento desde entonces, TD-10
  sin agravarse).

Sin hallazgos nuevos.

## Verificación (todo corrido de nuevo en esta fase, no reciclado)

- Backend: `npx jest` → **514/514**. `npx jest --config
  test/jest-integration.json` (Postgres real) → **436/436**.
  `npx stryker run --mutate "src/modules/expenses/**/*.service.ts"` →
  **98.85%** (sin cambios desde la Fase 08). `npx tsc --noEmit` limpio.
  `npx eslint "{src,apps,libs,test}/**/*.ts"` limpio. `npm run build`
  limpio.
- Frontend: `npx tsc -b` limpio. `npx eslint .` → 1 warning
  pre-existente (TD-6, sin relación con este módulo). `npx vitest run`
  → **84/84**. `npm run build` limpio, bundle sin crecimiento.

## Análisis estático

`grep` de `TODO`/`FIXME`/`XXX`, de `process.env`/`ConfigService`, de
`$queryRaw`/`$executeRaw`, de `dangerouslySetInnerHTML`, y lectura
directa de la migración SQL para el análisis de índices — todo cubierto
arriba, sección por sección.

```
PRODUCTION READY: YES

CRITICAL ISSUES: 0
HIGH ISSUES: 0
MEDIUM ISSUES: 0
LOW ISSUES: 2 (TD-16 rate limiting, TD-17 índices de fecha — ambos
  transversales al sistema, no específicos ni originados en este
  módulo, ya documentados como deuda técnica aceptada)

TEST RESULTS: 514/514 unitarios backend, 436/436 integración (Postgres
  real), 84/84 Vitest frontend — todos corridos de nuevo en esta fase.
  Mutación 98.85% (Stryker), 3 sobrevivientes documentados como
  equivalentes/inalcanzables.
SECURITY RESULTS: sin CRITICAL/HIGH/MEDIUM en 2 auditorías
  independientes (Fases 09 y 11) más esta revisión — autenticación,
  autorización, CSRF, mass-assignment, IDOR, inputs maliciosos y
  exposición de información reconfirmados en vivo contra el servidor
  real.
PERFORMANCE RESULTS: sin N+1, sin duplicación de consultas, sin
  operaciones innecesarias. 1 LOW nuevo (TD-17, sin índice en `fecha`)
  — pre-existente y transversal a `sales`/`returns`, no bloqueante a la
  escala del MVP.
REMAINING RISKS: TD-16 (rate limiting) y TD-17 (índices de fecha),
  ambos LOW, ambos transversales a varios módulos del sistema — revisar
  juntos si el volumen real de uso lo justifica, no como fix aislado de
  este módulo.
```

## Problemas pendientes

Ninguno que bloquee. **Módulo `expenses`/`resultados` aprobado — pasa
a la Integration Audit cuando corresponda, junto con el resto de los
módulos del MVP. Etapa 6 (`expenses`/`resultados`) completamente
cerrada: T6.1–T6.9 VERDE + Fases 07→12 VERDE, mismo camino que
`sales`/`returns` recorrieron antes. Con este cierre, los 6 módulos del
MVP (`auth`, `products`, `sales`, `cash-registers`, `returns`,
`expenses`/`resultados`) tienen su ciclo de construcción y cierre
completo.**
