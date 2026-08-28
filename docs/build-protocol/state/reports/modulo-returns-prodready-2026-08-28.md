# Production Readiness Review — módulo `returns` (2026-08-28)

Fase 12 del protocolo — gate de cierre definitivo del módulo. Precondición
verificada: Fase 11 VERDE (`state/STATUS.md`, commit `a4c272b`). **Sin
código modificado** — regla de la fase; única escritura de esta fase es
este reporte y el bookkeeping de `TECH_DEBT.md`/`STATUS.md`.

## Security

- Authentication/authorization aplicadas correctamente: las 3 rutas de
  `ReturnsController` y la extensión de T5.8 en `SalesController`
  pasan por `AuthGuard` global; `esOwner` resuelto siempre del JWT,
  nunca del body. Reconfirmado EN VIVO en las Fases 09 y 11 (dos
  corridas independientes, mismo resultado).
- Secrets: sin secretos hardcodeados en ningún archivo de `returns`.
- Data exposure: `costoUnitario` ausente (no `null`) del JSON para
  `SELLER` en `GET /returns/sales/:numero` — probado explícitamente.
- El único hallazgo HIGH de todo el ciclo (manipulación de IDs,
  `saleItemId` de una venta ajena) se encontró y corrigió en la Fase
  08, y se reconfirmó corregido en vivo dos veces más (Fases 09 y 11).
  **Sin CRITICAL ni HIGH pendientes.**

## Reliability

- Errors: cada camino de rechazo (venta anulada, sin sesión, tope
  excedido, fuera de plazo, suma de reintegros incorrecta, línea
  ajena) devuelve un status/mensaje de negocio claro — nunca un 500
  genérico ni un stack trace (`GlobalExceptionFilter`, ya auditado en
  `auth`, cubre lo no controlado).
- Timeouts/retries: sin llamadas a servicios externos en este módulo
  (todo es Postgres vía Prisma, dentro de la misma transacción) — no
  aplica.
- External failures: no aplica, mismo motivo.
- Inconsistent states: atomicidad garantizada por una única
  transacción Prisma (`crearDevolucion` recibe siempre el `tx` ya
  abierto, nunca abre el suyo). Rollback completo verificado en cada
  camino de rechazo (T5.1–T5.8, más el caso de manipulación de IDs de
  la Fase 08) — sin filas huérfanas en ningún escenario probado.
  Concurrencia real verificada con Postgres real: dos devoluciones
  parciales simultáneas de la misma línea (T5.6, invariante 8) y dos
  ventas simultáneas gastando el mismo crédito (T5.5/T5.8, invariante
  14) — en ambos casos, una pasa, la otra rechaza, nunca las dos.

## Performance

- Queries revisadas una por una (`crearDevolucion`,
  `buscarVentaParaDevolucion`, `consultarCredito`): todas las lecturas
  agrupadas usan `WHERE id IN (...)`/`findMany`, nunca un loop de
  queries individuales — sin N+1 accidental.
- El único patrón "N queries por N líneas" es
  `stockService.reingresarPorDevolucion`, una llamada por línea con
  `reingresaStock: true` — **requisito literal del blueprint** ("un
  `stock_movement` por línea"), mismo criterio ya aceptado en la Fase
  12 de `sales` para `descontarPorVenta`. No es un N+1 accidental.
- **Observación menor, no bloqueante** (ya señalada en la Fase 08): el
  lock (paso 4) y la lectura de `previousReturnItems` (paso 5) siguen
  usando los `saleItemId` tal como vienen del request, ANTES del
  filtro por `saleId` — en el camino feliz (que es 100% de los casos
  reales, dado que la pantalla de devolución solo puede ofrecer
  `saleItemId` que ya pertenecen a la venta) esto no tiene ningún
  costo extra; en un intento de manipulación de IDs (ya rechazado por
  el fix de la Fase 08), hace una lectura/lock de una fila que después
  se descarta. Costo insignificante (una fila), y solo se paga en un
  escenario de ataque ya bloqueado — no amerita cambio de código.
- `buscarVentaParaDevolucion` abre su propia transacción
  `RepeatableRead` de solo lectura (mismo criterio que `reconciliar()`
  de `sales`/`cash-registers`/`stock`) — sin lock, no compite con
  escrituras concurrentes de `crearDevolucion`.
- Memory: sin acumulación de datos en memoria más allá de lo que cada
  venta/devolución individual requiere (líneas de una venta, nunca
  listados completos — `GET /returns`/`GET /returns/:id`, que sí
  necesitarían paginación por BLUEPRINT §12.4, siguen explícitamente
  fuera de alcance, sin ticket que los reserve).
- Slow endpoints: sin medición de latencia real en este entorno de
  desarrollo — la forma de las queries (agregados/`findMany` acotados
  por `IN`, sin listados sin paginar) no sugiere ningún endpoint
  lento a la escala del MVP (una tienda).

## Code quality

- Arquitectura: `ReturnsService` sigue el mismo contrato que
  `SalesService`/`StockService` (recibe siempre `tx`, nunca abre su
  propia transacción de escritura); reusa `SalesService.crearVenta`
  tal cual para la venta nueva de un `CAMBIO`, sin reimplementar
  ninguna regla de venta — exactamente como diseñó la spec (sección
  1, "este módulo NO es dueño de...").
- Duplicación: el paralelismo estructural entre `crearDevolucion` y
  `crearVenta` (mismo patrón de pasos numerados, mismo criterio de
  lock) es deliberado — mismo estilo ya establecido en el resto del
  proyecto, no hay una clase base compartida que valga la pena
  extraer para dos casos.
- Complejidad: `crearDevolucion` es un método largo (~290 líneas, 15
  pasos comentados) — mismo patrón y longitud relativa que
  `crearVenta`, ya aceptado en la Fase 12 de `sales`.
- Mantenibilidad: cada hallazgo real de esta Etapa 5 (T5.5 ×2, Fase 08
  ×1, T5.8 ×2) está documentado en el comentario del código exacto
  donde se corrigió, no solo en `STATUS.md` — quien lea el archivo
  entiende el porqué sin tener que ir a buscar la bitácora.
- Sin `TODO`/código muerto/comentado (confirmado en la Fase 07,
  reconfirmado ahora — sin cambios de código desde entonces).

## Observability

- Logs: el logger HTTP global (`nestjs-pino`, ya auditado en `auth`)
  captura cada request a `returns` con método/status/tiempo de
  respuesta, redactando cookies — sin logging custom agregado en el
  módulo (mismo criterio que el resto del backend).
- Mensajes de error: en lenguaje de negocio ("La línea X no existe en
  esta venta", "El crédito de la devolución #N no alcanza —
  disponible: $X") — útiles tanto para quien opera el mostrador como
  para debugging (BLUEPRINT §12.6 regla 2).

## Deployment

- Environment variables: sin variables nuevas — `dias_plazo_devolucion`
  es un setting de base de datos (`SettingsService`), no una env var,
  ya sembrado desde T0.13.
- Migrations: sin migración nueva para todo el ciclo T5.1–T5.8 — los
  modelos `Return`/`ReturnItem`/`ReturnPayment` ya existían desde la
  Fase 01 (confirmado en la spec, sección de fuentes).
- Configuration: `.claude/launch.json` ganó una entrada `backend`
  (T5.8) para poder correr el servidor real en verificaciones
  manuales — infraestructura de desarrollo, no de producción.
- Build: backend (`nest build`) y frontend (`tsc -b && vite build`)
  limpios, reconfirmados en esta misma fase. Bundle frontend: 660.36
  kB / 199.92 kB gzip (TD-10 ya documentado, sin agravarse desde
  T5.8).

## Tests

```
Backend:  418/418 unitarios, 354/354 integración (Postgres real,
          reconfirmado dos veces sin flakes en esta sesión)
Frontend: 84/84 Vitest
tsc --noEmit / tsc -b / lint (los dos) / nest build / vite build:
          limpios
Mutación (Stryker, BLUEPRINT §9.8): 99.05% (umbral 80%, superado)
```

## Deuda técnica registrada

TD-9 (LOW, `npm audit` de la cadena `prisma` CLI, transversal, sin
cambios), TD-15 (LOW, `POST /returns` sin rate limiting, mismo patrón
que TD-12/TD-14, nueva en esta etapa) — ambas en `state/TECH_DEBT.md`.

## Riesgos restantes documentados, ninguno bloqueante

- `GET /returns`, `GET /returns/:id` (listado/detalle históricos) sin
  ruta HTTP — gap de alcance ya señalado en la Fase 07, sin ticket que
  lo reserve (mismo criterio que los gaps ya aceptados de `sales`).
- La observación menor de performance de la sección correspondiente
  (lectura/lock de más solo en el camino de ataque ya bloqueado).

---

```
PRODUCTION READY: YES

CRITICAL ISSUES: 0
HIGH ISSUES: 0
MEDIUM ISSUES: 0
LOW ISSUES: 2 (TD-9, TD-15 — ambas documentadas, no bloquean)

TEST RESULTS: 418/418 unitarios, 354/354 integración, 84/84 Vitest —
  todo verde, reconfirmado en esta misma fase
SECURITY RESULTS: sin CRITICAL ni HIGH en 3 rondas independientes
  (Fases 09/11/12) — 1 HIGH real encontrado y corregido en la Fase 08
PERFORMANCE RESULTS: sin N+1 accidental, sin queries sin paginar
  expuestas por HTTP, sin observaciones bloqueantes
REMAINING RISKS: ninguno bloqueante — ver sección de riesgos arriba
```

**Módulo `returns` aprobado — pasa a la Fase 13 (Integration Audit)
cuando corresponda, junto con el resto de los módulos del MVP.**
