# Production Readiness Review — módulo `sales` (2026-08-25)

Fase 12 del protocolo, gate de cierre del módulo. **Sin código
modificado** (regla de la fase — "NO CORRIJAS NADA"; la única escritura
de esta fase fue de bookkeeping, no de código: registrar TD-13/TD-14 en
`state/TECH_DEBT.md`, un requisito explícito de `QUALITY_GATE.md`
["Todo MEDIUM/LOW aceptado está registrado..."] que había quedado
pendiente desde la Fase 10 — omisión propia corregida acá, mismo
criterio que `cash-registers` siguió con TD-11/TD-12). Alcance:
T4.1–T4.11, fases 07–11 ya en VERDE. Todo lo de abajo se corrió de
nuevo en esta fase, no reciclado de reportes anteriores.

---

## Security

- **Authentication/authorization**: `AuthGuard`/`RolesGuard` globales
  cubren la única ruta real (`POST /sales`); RN-1 ("cualquiera
  autenticado") confirmado sin `@Roles()`, `esOwner` siempre resuelto
  del JWT verificado (nunca del body) — reconfirmado en la Fase 11 con
  401/403 reales contra el servidor.
- **Secrets**: el módulo no maneja ni referencia ninguno.
- **Data exposure**: `POST /sales` devuelve el objeto `Sale` base, sin
  `items`/`payments`/`discounts` anidados — no hay ninguna respuesta
  HTTP de este módulo que incluya `costoUnitario` hoy (RN-10 no tiene
  superficie que auditar todavía, señalado para cuando exista
  `GET /sales`).
- Sin CRITICAL ni HIGH en ninguna de las fases 08–11. El HIGH matizado
  de CSRF (Fase 09) está corregido y reconfirmado en vivo (Fase 11).
  4 LOW documentadas (TD-13, TD-14, más las 2 de infraestructura
  compartida ya cubiertas por TD-11/TD-12 de `cash-registers`), ninguna
  bloqueante según `QUALITY_GATE.md`.

## Reliability

- **Errores**: todo pasa por `GlobalExceptionFilter`, normalizado a
  `{statusCode, timestamp, path, message}` — sin stack traces expuestos
  (confirmado en Fase 08/11, incluido el caso que antes tiraba 500
  crudo por desborde de precisión, ya corregido).
- **Estados inconsistentes**: todo rechazo de `crearVenta`/`anularVenta`
  ocurre ANTES de la primera escritura — confirmado leyendo el flujo
  completo y con los tests de "rechazos con rollback completo" (Fase
  07/08), que verifican explícitamente que no queda ninguna fila en
  `sales`/`stock_movements`/`cash_movements` tras cada rechazo. El lock
  de sesión de caja (siempre, no solo con pago en efectivo) y el lock
  de variantes ordenado por id (BLUEPRINT §9.4) previenen las dos
  carreras reales del módulo — probadas empíricamente con concurrencia
  real en T4.9 y en la sección "Concurrencia del lock temprano de
  sesión de caja" de la integración.
- **Timeouts/retries/fallos externos**: el módulo no agrega ninguna
  lógica propia — hereda el comportamiento de Prisma/Postgres del resto
  del sistema (mismo perfil ya evaluado en las Fases 12 de `auth`/
  `products`/`cash-registers`, no es un gap nuevo). Sin reintentos
  automáticos — correcto por diseño: `Idempotency-Key` (T4.5) resuelve
  el "doble click"/reintento de red, un retry ciego sin esa protección
  podría duplicar una venta real.

## Performance

- **Queries por request**: `crearVenta` hace un número fijo y chico de
  queries de estructura (sesión, 2 locks, lectura de variantes,
  settings, `sale.create` nested) más una consulta triple
  (`findUniqueOrThrow`/`create`/`update`) por CADA línea en
  `stockService.descontarPorVenta` — un patrón con forma de N+1, pero
  **deliberado, no accidental**: BLUEPRINT §5.3 paso 6 exige
  literalmente "un `stock_movements`... por línea", mismo criterio que
  `cash-registers` aceptó para su propio caso análogo en su Fase 12.
  Acotado en la práctica por `@ArrayMaxSize(500)` en `items`
  (`CreateSaleDto`, Fase 10) — el caso extremo teórico (500 líneas)
  sigue siendo 1500 queries de stock en una sola transacción, alto pero
  finito y explícitamente limitado, no ilimitado como antes de esa
  fase.
- **`reconciliar()` sin paginar**: escanea TODAS las `sales` y agrupa
  TODOS los `payments` de una vez (`findMany`/`groupBy` sin `take`/
  `skip`) — mismo criterio ya aceptado para el método análogo de
  `cash-registers` (Fase 12 de ese módulo): **no está expuesto por
  ningún endpoint HTTP** (confirmado: sin match en
  `sales.controller.ts`), es una función de mantenimiento interna. No
  se registra como TD nuevo por el mismo motivo ya documentado ahí.
- **Bundle frontend**: 642.92 kB / 195.60 kB gzip (build real de esta
  fase) — creció desde los 611 kB / 187 kB gzip que dejó `products`
  (TD-10), consistente con agregar las pantallas de venta/cobro
  (`SalePage.tsx`/`CobroPage.tsx`). Sigue siendo el mismo TD-10, no uno
  nuevo — la nota de esa entrada ("revisar si sigue creciendo con
  `sales`/`cash-registers`/`returns`") es exactamente este caso.

## Code quality

- **Arquitectura**: separación DTO → controller (delgado, abre la
  transacción, resuelve `esOwner`) → service (lógica de negocio)
  consistente con el resto del sistema. `crearVenta`/`anularVenta`
  nunca abren su propia transacción (contrato explícito, respetado en
  las 11 sesiones de construcción del módulo) — la única excepción
  documentada y justificada es `reconciliar()` (invariante 3, mismo
  criterio que `stock`/`cash-registers`).
- **Duplicación**: ninguna dentro del módulo (revisada en Fase 07).
  `assertDentroDePrecision()` (Fase 08) es local a `sales`, con el
  mismo `MAX_MONTO_ABSOLUTO` que la copia independiente de
  `cash-registers` — duplicación cross-módulo señalada explícitamente
  en el propio código (comentario en `sales.service.ts`) y en el
  reporte de la Fase 08, sin unificar a propósito (misma decisión que
  el resto del sistema tomó para casos análogos).
- **Complejidad**: `crearVenta` es el método más largo del sistema (11
  pasos documentados con su propio comentario), pero lineal — sin
  ramas anidadas más de un nivel, cada paso con una responsabilidad
  clara y su propio comentario justificando el porqué (no el qué).
  Sin `TODO`/`FIXME`/`XXX` en el módulo (`grep` en backend y frontend:
  cero resultados reales — los tres matches de "TODO" son la palabra
  española "todo", no marcadores).
- **Mantenibilidad**: cobertura de mutación **100.00%** sobre
  `sales.service.ts` (Fase 08, 232 mutantes matados, 0 sobrevivientes)
  — la señal más fuerte disponible de que la suite de tests realmente
  documenta el comportamiento esperado, no solo lo ejercita.

## Observability

- Sin logging propio del módulo (ningún `Logger`/`console.*` en
  `sales/`) — mismo perfil que el resto del sistema, que confía en
  `pinoHttp` (logging automático de cada request) más el
  `GlobalExceptionFilter`. No es un gap nuevo de este módulo.
- Los mensajes de error del servicio ("Stock insuficiente: quedan N
  unidades", "El descuento supera el límite del vendedor (N%)", "El
  ajuste de redondeo deja el total en negativo", etc.) son
  suficientemente específicos para diagnosticar un problema real sin
  necesitar logs adicionales — confirmado contra la tabla de errores
  de la spec (sección 7), todos implementados tal cual.

## Deployment

- **Variables de entorno**: el módulo no agrega ninguna nueva — usa
  `FRONTEND_URL`/`JWT_SECRET`/config de base de datos ya validados
  globalmente. `OriginCheckMiddleware` (Fase 10) reusa `FRONTEND_URL`,
  no agrega una variable propia.
- **Migraciones**: `npx prisma migrate status` → "Database schema is
  up to date" (4 migraciones totales; dos son de este módulo:
  `sales_descuento_total_check` y `sales_total_check`, ambas de la
  Fase 08).
- **Build**: backend (`nest build`) y frontend (`tsc -b && vite
  build`) verdes, sin warnings nuevos más allá de los ya documentados
  (TD-7 deprecación de `package.json#prisma`, TD-10 tamaño de bundle,
  ambos preexistentes).

---

## Test results

Corridos de nuevo en esta fase, no reciclados:

- Backend unitarios: **346/346** verde.
- Backend integración: **288/288** verde (Postgres real).
- Frontend Vitest: **71/71** verde.
- Mutación (`sales.service.ts`, Fase 08): **100.00%** — 232 matados, 0
  sobrevivientes, 0 sin cobertura.
- Migraciones: al día, sin pendientes.

## Security results

Sin CRITICAL ni HIGH en ninguna fase de seguridad (08/09/10/11). El
único HIGH matizado (CSRF, Fase 09) está corregido (Fase 10) y
reconfirmado en vivo contra el servidor real (Fase 11). 4 LOW
documentadas y aceptadas (TD-13, TD-14, más TD-11/TD-12 de
infraestructura compartida que también cubren a este módulo) — ninguna
bloquea el Quality Gate.

## Performance results

Sin N+1 accidental en ningún endpoint HTTP — el único patrón con forma
de N+1 (`descontarPorVenta` por línea) es un requisito literal del
blueprint, ahora acotado por `@ArrayMaxSize(500)`. Un método interno
sin paginar (`reconciliar()`, no expuesto por HTTP) — riesgo bajo, no
bloqueante, mismo criterio ya aceptado para `cash-registers`. Bundle
frontend con el warning preexistente de tamaño (TD-10), creció de forma
esperable con las pantallas de este módulo.

## Remaining risks

- **TD-13** (LOW, nueva de esta fase de cierre) — `payments.referencia`
  sin formato validado; riesgo bajo porque la UI real no lo usa hoy.
- **TD-14** (LOW, nueva de esta fase de cierre) — sin rate limiting en
  `POST /sales`, consistente con el resto del sistema (TD-12).
- **AMB-15** (`state/AMBIGUITIES.md`, PENDIENTE) — `crearVenta` no
  chequea `variant.product.activo`; una variante activa de un producto
  dado de baja se puede vender igual. Sin fuente que confirme si es
  intencional — queda para el PO, no bloquea el uso real del módulo
  hoy.
- **Gaps de alcance ya señalados en la Fase 07, sin ticket propio
  todavía**: `GET /sales`, `GET /sales/:id`, `POST /sales/:id/anular`
  (el servicio de anulación existe y está probado, sin ruta HTTP).
  Ninguno bloquea el uso real del módulo hoy (la única pantalla
  existente, `CobroPage.tsx`, no los necesita), pero son
  funcionalidad de la spec original sin construir — quedan para una
  decisión explícita, no para esta fase.
- Los MEDIUM ya existentes de `auth` (TD-3, TD-4) y el LOW de `products`
  (TD-8) siguen aplicando de forma transversal a todo el sistema,
  incluido este módulo — no son hallazgos nuevos de `sales`.

---

```
PRODUCTION READY: YES

CRITICAL ISSUES: 0
HIGH ISSUES: 0 (el matizado de CSRF de la Fase 09 está corregido y reconfirmado)
MEDIUM ISSUES: 0 nuevos (TD-3/TD-4 de auth siguen aplicando de forma transversal, no son de este módulo)
LOW ISSUES: 2 nuevas de este módulo (TD-13, TD-14), más TD-7/TD-9/TD-10/TD-11/TD-12 transversales ya conocidas

TEST RESULTS: 346/346 unitarios, 288/288 integración, 71/71 frontend — todo verde; mutación 100.00% en sales.service.ts
SECURITY RESULTS: sin CRITICAL/HIGH en fases 08-11; CSRF corregido y reconfirmado en vivo; auth/authz verificadas
PERFORMANCE RESULTS: sin N+1 accidental en rutas HTTP; el patrón "un movimiento por línea" es requisito del blueprint, acotado por ArrayMaxSize(500); reconciliar() sin paginar pero no expuesto por HTTP
REMAINING RISKS: TD-13, TD-14 (LOW, este módulo); AMB-15 pendiente de resolución del PO; GET/anular sin ruta HTTP (gap de alcance ya documentado); TD-3/TD-4/TD-8/TD-10 transversales
```

**Módulo `sales` aprobado — pasa a la fase 13 (Integration Audit).**
