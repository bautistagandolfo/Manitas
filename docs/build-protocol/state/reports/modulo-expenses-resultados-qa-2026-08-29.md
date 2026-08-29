# Fase 08 — QA adversarial del módulo `expenses` + `resultados`

2026-08-29. Rama `fase08-qa-expenses-resultados`, sobre el cierre de
Fase 07 (`docs/build-protocol/state/reports/modulo-expenses-resultados-fase07.md`).

## 1. Lógica de negocio / integridad — mutation testing (Stryker)

Módulo de plata/cálculo → Stryker obligatorio (protocolo, umbral 80%),
sobre los 3 `*.service.ts` de `src/modules/expenses/`.

Corrida final (después de la remediación de este documento):

| Archivo | Mutation score | Mutantes | Sobrevivientes documentados |
|---|---|---|---|
| `expense-categories.service.ts` | 98.77% | 81 | 1 |
| `expenses.service.ts` | 100.00% | 54 | 0 |
| `resultados.service.ts` | 98.40% | 125 | 2 |
| **Total módulo** | **98.85%** | 260 | 3 |

Los tres archivos superan holgadamente el umbral de 80%. La corrida
inicial (antes de esta fase) tenía `expense-categories.service.ts` en
75.31% (BLOQUEADO) — se remedió agregando tests dirigidos a los
sobrevivientes reales (mensajes de error exactos, propagación de errores
no-P2002, límites Unicode exactos del filtro de diacríticos, boundary
exacto de "≤ 2 decimales", filtro `desde`/`hasta` independiente,
`count()` con el mismo `where` que la página, aislamiento
`RepeatableRead` en `rankingProductos`/`gastosPorCategoria`, devolución
huérfana, `reingresaStock: true` en el ranking, y desempates construidos
para que la comparación en sí distinga la implementación real de la
mutada — varios de los desempates existentes "sobrevivían" antes por
coincidencia de los datos de prueba, no porque el código estuviera mal).

### 1.1. Sobrevivientes aceptados (documentados, no forzados)

Los 3 mutantes que quedan sin matar son estructuralmente equivalentes o
inalcanzables — forzar un test artificial para ellos no agrega
protección real, mismo criterio ya usado para `returns` en una fase
anterior:

1. **`expense-categories.service.ts:36`** — `codigo > ULTIMO_DIACRITICO_COMBINANTE`
   mutado a `false`. Solo se puede distinguir de la implementación real
   con un carácter Unicode de código de punto ESTRICTAMENTE mayor a
   `0x036F` (fuera del rango de "Combining Diacritical Marks") — en la
   práctica, letras de otros alfabetos (cirílico, griego, CJK) en un
   nombre de categoría, un caso sin relevancia de negocio real para
   AD-7 (que es específicamente sobre texto en español). Un test para
   esto sería sintético, no un escenario real.
2. **`resultados.service.ts:102`** — `desde.getTime() > hasta.getTime()`
   mutado a `>=`. Inalcanzable: `desde` siempre sale de
   `argentinaWallTimeToUtc(..., 0,0,0,0)` (medianoche) y `hasta` siempre
   de `argentinaWallTimeToUtc(..., 23,59,59,999)` (fin del día) — ambos
   instantes nunca pueden ser numéricamente iguales para ningún par de
   fechas válidas, ni siquiera con `desde === hasta` (mismo día): el
   inicio de un día y el fin de un día jamás coinciden. El `>=` y el `>`
   se comportan idéntico para todo input alcanzable.
3. **`resultados.service.ts:281`** — `query.orden ?? 'unidades'` mutado
   a `query.orden ?? ""`. El valor default nunca se compara contra nada
   más que `=== 'margen'` — cualquier string que no sea `'margen'` (sea
   `'unidades'` o `""`) toma exactamente la misma rama. El mutante es
   funcionalmente equivalente para cualquier input posible, no solo para
   los tests actuales.

## 2. API — parámetros inválidos, tipos incorrectos, requests incompletos

### 2.1. Hallazgo real — corregido: fecha de calendario inválida aceptada en silencio

**SEVERIDAD**: Alta (`/resultados`, cálculo financiero), Media
(`/expenses`, listado).

**REPRODUCCIÓN** (antes del fix): `GET /resultados?desde=2026-02-30&hasta=2026-02-28`
(o cualquier query con un día que no existe en el calendario, como
"31 de abril" o "29 de febrero" en un año no bisiesto).

**ESPERADO**: 400 — la fecha no es válida.

**REAL** (antes del fix): 200. `@IsDateString()` (class-validator) solo
valida el FORMATO ISO ("YYYY-MM-DD"), nunca que el día exista en ese
mes/año. `argentinaDayRangeToUtc` (T0.7) tenía el mismo problema en su
propio chequeo de formato (un regex, tampoco calendario-consciente), y
`Date.UTC(2026, 1, 30, ...)` no rechaza un día fuera de rango: lo
normaliza en silencio al 2 de marzo. El resultado calculado era el de
OTRO rango de fechas, sin ningún indicio de error para quien hizo el
pedido. La misma clase de bug existía, independiente, en el filtro
crudo `GET /expenses?desde=...` (ahí vía `new Date(...)` directo en el
controller, confirmado con el mismo comportamiento de "rollover
silencioso").

**ROOT CAUSE**: ninguna de las dos validaciones en juego
(`@IsDateString()` de class-validator, el regex `FECHA_YYYY_MM_DD` de
`argentina-timezone.util.ts`) verifica que el día exista en el
mes/año declarados — ambas son puramente sintácticas.

**FIX**:
- [argentina-timezone.util.ts](../../../../backend/src/common/timezone/argentina-timezone.util.ts) —
  `argentinaDayRangeToUtc` reconstruye la fecha vía `Date.UTC` y
  confirma que año/mes/día declarados sobreviven el round-trip; si no
  coinciden (el día no existe), tira `BadRequestException` — de paso,
  también se corrigió que el chequeo de FORMATO tiraba un `Error` común
  en vez de `BadRequestException` (sin captura explícita en
  `ResultadosService`, un formato inválido habría dado 500, no 400 —
  hallazgo secundario, mismo fix).
- [find-expenses-query.dto.ts](../../../../backend/src/modules/expenses/dto/find-expenses-query.dto.ts) —
  agrega un `ValidatorConstraint` (`IsValidCalendarDateConstraint`) que
  hace el mismo round-trip sobre los primeros 10 caracteres del string
  (`YYYY-MM-DD`), para que el `ValidationPipe` global rechace con 400
  antes de que el valor llegue al controller — no reusa
  `argentinaDayRangeToUtc` a propósito: ese listado deliberadamente NO
  convierte a hora argentina (ver comentario de la clase), reusar esa
  función habría introducido una conversión de zona horaria que la
  spec de este endpoint no pide.

**Tests de regresión**: `argentina-timezone.util.spec.ts` (30 de
febrero, mes 13, 31 de abril, 29 de febrero en año bisiesto vs no
bisiesto), `resultados.integration.spec.ts` (`desde`/`hasta` con día
inexistente → 400), `expenses.integration.spec.ts` (`it.each` con
`2026-02-30`/`2026-04-31`/`2026-13-01`, más `hasta` inválido → 400).

Verificado que el fix no afecta a `sales`/`returns`/`cash-registers`:
`argentinaDayRangeToUtc` solo lo consume este módulo (`grep` confirmado,
sin otros importadores).

### 2.2. Revisado, sin hallazgos

- **Paginación** (`GET /expenses`): `page`/`pageSize` con `@Min`/`@Max`
  (`pageSize` tope 100) — un `pageSize` gigante o negativo se rechaza
  con 400 del `ValidationPipe`, no llega al servicio.
- **`orden` fuera de la lista permitida** (`GET /resultados/ranking-productos?orden=x`) —
  `@IsIn(['unidades', 'margen'])` rechaza con 400 genérico.
- **Body con campos extra/no declarados** (`POST /expenses` con
  `id`/`userId`/`idempotencyKey` forzados en el body) — ya cubierto en
  T6.2 (`expenses.integration.spec.ts:646`), el `ValidationPipe` global
  tiene `whitelist`/`forbidNonWhitelisted` — se rechaza con 400, no se
  ignoran en silencio.
- **`POST /expenses` sin header `Idempotency-Key`** → 400, ya cubierto
  en T6.2.
- **Reintento con la misma `Idempotency-Key`** → devuelve la fila
  existente (200 o 201, ambos aceptados — mismo contrato ya auditado en
  `sales`), no duplica.
- **`PATCH /expense-categories/:id` con id no numérico** —
  `ParseIntPipe` rechaza con 400 antes de llegar al servicio.

## 3. UI

El frontend de este módulo (`features/expenses/`, `features/settings/`,
T6.8/T6.9) se construyó reusando, campo por campo, los patrones ya
auditados de `CatalogPage.tsx` (paginación, estados vacíos/error/loading)
y `ManualMovementModal.tsx` (idempotencia, doble-click). No se encontró
nada nuevo en esta fase que ameritara una revisión manual exhaustiva
aparte — los estados de carga/error/vacío, el formato es-AR de
importes/fechas (vía los helpers comunes, nunca a mano) y la protección
`RequireOwner` de las 3 rutas nuevas (`/gastos`, `/resultados`,
`/configuracion`) ya se verificaron manualmente en el navegador durante
T6.8/T6.9 (ver STATUS.md, filas correspondientes). Sin hallazgos nuevos.

## 4. Security

- **Autenticación**: las 3 rutas de `resultados`, las 2 de `expenses` y
  las 2 de `settings` devuelven 401 sin sesión (confirmado en los specs
  de integración existentes de cada uno).
- **Autorización (RBAC)**: `expenses` y `resultados` son
  `@Roles(OWNER)` en TODAS sus rutas — un SELLER recibe 403 (confirmado,
  spec existente). `settings` también OWNER-only. `expense-categories`
  deliberadamente SIN `@Roles` (spec del módulo, sección 2: gestionar
  categorías de gasto no es sensible por sí solo, a diferencia de ver
  los montos) — decisión ya revisada y confirmada correcta en Fase 07,
  no un hallazgo nuevo.
- **IDOR / manipulación de IDs**: `ParseIntPipe` en los `:id`/`:clave`
  de rutas con parámetro — un id no numérico o inexistente da 400/404,
  nunca expone datos de otro tenant (no hay multi-tenant en este
  sistema — un solo local, confirmado en `MVP_SCOPE.md`).
- **Inputs maliciosos**: el `ValidatorConstraint` nuevo (sección 2.1) es
  puramente aritmético sobre un string ya format-validado por
  `@IsDateString()` — sin construcción de fechas fuera de rangos
  numéricos razonables, sin riesgo de ReDoS (el regex `/^(\d{4})-(\d{2})-(\d{2})/`
  no tiene backtracking catastrófico posible).
- **Exposición de información**: los mensajes de error de este módulo
  (confirmados exactos contra la spec en Fase 07) no filtran detalles
  internos (nombres de columna, stack traces, SQL) — genéricos y en
  español, mismo criterio que el resto del sistema.

Sin hallazgos nuevos en esta categoría.

## Resumen

| Categoría | Resultado |
|---|---|
| Lógica de negocio / mutation testing | 1 hallazgo real (75.31% bloqueado) → remediado, 98.85% final |
| API | 1 hallazgo real (fecha de calendario inválida) → remediado en 2 puntos |
| UI | Sin hallazgos nuevos |
| Security | Sin hallazgos nuevos |

## Verificación final

- `npx jest` (unitarios): 514/514.
- `npx jest --config test/jest-integration.json` (Postgres real): 436/436.
- `npx stryker run --mutate "src/modules/expenses/**/*.service.ts"`:
  98.85% global, los 3 archivos por encima del umbral de 80%.
- `npx tsc --noEmit`: limpio.
- `npx eslint "{src,apps,libs,test}/**/*.ts"`: limpio.
- `npm run build`: limpio.

## Problemas pendientes

Ninguno dentro del alcance de Fase 08. Sigue Fase 09 (auditoría de
seguridad, sin cambios de código).
