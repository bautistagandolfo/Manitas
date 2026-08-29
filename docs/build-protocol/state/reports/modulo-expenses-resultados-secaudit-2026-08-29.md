# Fase 09 — Security Audit del módulo `expenses` + `resultados`

2026-08-29. Rama `fase09-secaudit-expenses-resultados`, ramificada de
Fase 08 VERDE (`fase08-qa-expenses-resultados`). **Sin ningún cambio de
código** — regla de la fase. Todo lo descrito acá se verificó EN VIVO
contra el servidor real (`npm run start:dev`, Postgres real, sesiones
reales) además de leer el código; los usuarios de prueba creados
(`seller-fase09@manitas.local`) y las categorías creadas durante las
pruebas se desactivaron al terminar (sin `DELETE` físico disponible,
RN-1) — sin residuo funcional en la base de dev real más allá de filas
`activo: false`/`bloqueada: false` que ya no aparecen en ningún flujo
real.

Alcance de rigor (decidido en la Fase 06, sección 11, reconfirmado acá):
auditoría **completa** para `expenses`/`expense-categories`/`settings`
(mueven dinero o configuración real); **`resultados` es de solo lectura**
— las categorías que dependen de mutación de estado (CSRF, mass-
assignment, rate limiting de escritura) no aplican ahí, se cubren igual
las que sí (autenticación, autorización, IDOR, exposición de
información, inputs maliciosos en query params).

## 1. Authentication

Las 8 rutas del módulo (`/expenses` ×2, `/expense-categories` ×3,
`/resultados` ×3, `/settings` ×2) exigen sesión — confirmado EN VIVO,
sin cookie → **401** en las 8. `AuthGuard` es global (JWT en cookie
`HttpOnly`, `SameSite=Lax` en dev), sin ruta `@Public()` en este módulo.

## 2. Authorization

`RolesGuard` global, después de `AuthGuard`. Confirmado EN VIVO con una
sesión `SELLER` real (usuario creado y desactivado al terminar la
auditoría):

| Ruta | `SELLER` | `OWNER` |
|---|---|---|
| `GET/POST /expenses` | 403 | 200/201 |
| `GET /resultados` (+ ranking, + gastos-por-categoría) | 403 | 200 |
| `GET/PATCH /settings` | 403 | 200 |
| `GET/POST/PATCH /expense-categories` | **200** (sin `@Roles`, a propósito) | 200 |

`expense-categories` sin restricción de rol es una decisión ya tomada y
documentada en la spec del módulo (sección 2, RN-1) y reconfirmada en la
Fase 07 — gestionar categorías (solo nombres, sin montos) no está en la
lista de exclusiones de `SELLER` de BLUEPRINT §5.1. No es un hallazgo
nuevo.

## 3. Access control

Igual a Authorization — mismo mecanismo (`@Roles`), sin lógica de
`ownership` adicional en este módulo (no hay recursos "propios de un
usuario" en `expenses`/`resultados`, a diferencia de, por ejemplo, un
carrito de compras). Sin hallazgos.

## 4. Privilege escalation

`UpdateExpenseCategoryDto` y `UpdateSettingDto`/`CreateExpenseDto` no
exponen ningún campo relacionado a rol/permisos — un `SELLER` no tiene
forma de escalar a `OWNER` a través de este módulo (no hay ningún
endpoint acá que toque `users.rol`). El mass-assignment de
`bloqueada`/`activo`/`id`/`userId` está bloqueado por el `ValidationPipe`
global (`whitelist`/`forbidNonWhitelisted`) — confirmado EN VIVO
(sección 6). Sin hallazgos.

## 5. IDOR

`ParseIntPipe` en `PATCH /expense-categories/:id` y `PATCH /settings/:clave` (`:clave` es un string, validado por existencia contra la tabla `Setting`, no un id numérico secuencial). Confirmado EN VIVO:

- `PATCH /expense-categories/999999` → 404 "Categoría de gasto no
  encontrada" (no expone si el id "existe pero pertenece a otro" — no
  hay otro tenant, sistema de un solo local).
- `PATCH /expense-categories/abc` → 400 "Validation failed (numeric
  string is expected)".
- `PATCH /settings/clave_que_no_existe` → 404, mensaje incluye la clave
  pedida (no filtra la lista de claves válidas, tampoco es información
  sensible — las 4 claves reales ya son públicas vía `GET /settings`
  para cualquier `OWNER`).

Sin `saleId`/`variantId`/ningún otro id "prestado" de otro recurso en
este módulo (a diferencia del hallazgo HIGH de `returns` en su propia
Fase 08) — `expenses`/`expense-categories` no referencian filas de otro
dueño lógico. Sin hallazgos.

## 6. Input validation

`ValidationPipe` global (`whitelist: true`, `forbidNonWhitelisted: true`,
`transform: true`). Confirmado EN VIVO:

- `POST /expenses` con `id`/`userId` forzados en el body → 400
  `["property userId should not exist","property id should not exist"]`.
- `PATCH /expense-categories/:id` con `bloqueada` forzada → 400
  `["property bloqueada should not exist"]`.
- `PATCH /settings/permitir_venta_sin_stock` con `valor:"no-es-bool"`
  (el tipo real es `BOOL`) → 400 con el mensaje de
  `SettingsService.setValor` (sección 2.1 del reporte de Fase 08).
- La validación de fecha de calendario agregada en la Fase 08
  (`argentinaDayRangeToUtc`, `IsValidCalendarDateConstraint`)
  reconfirmada EN VIVO: `GET /resultados?desde=2026-02-30` y
  `GET /expenses?desde=2026-02-30` → ambos 400, ninguno 200 con un
  rango corrido en silencio ni 500.

Sin hallazgos nuevos.

## 7. SQL injection

`grep` de `$queryRaw`/`$executeRaw` sobre `src/modules/expenses/`: sin
resultados. Las 3 services del módulo usan exclusivamente el query
builder tipado de Prisma (`findMany`/`aggregate`/`create`/`update`/
`count`) — sin concatenación de strings en ninguna consulta. Sin
superficie de inyección SQL en este módulo.

## 8. XSS

`grep` de `dangerouslySetInnerHTML` sobre `frontend/src/features/`: sin
resultados (ni en este módulo ni en el resto del frontend). React
escapa por default; sin HTML crudo renderizado en ningún componente de
`expenses`/`settings`/`resultados`. Sin hallazgos.

## 9. CSRF

`OriginCheckMiddleware` (global, agregado en la Fase 10 de `sales`)
cubre las 4 rutas mutadoras de este módulo (`POST /expenses`,
`POST`/`PATCH /expense-categories`, `PATCH /settings/:clave`).
Reconfirmado EN VIVO: `POST /expense-categories` con
`Origin: https://evil.example.com` + cookie real de sesión → **403
"Origen no autorizado"**, antes de tocar la sesión ni la base. El mismo
pedido con `Origin` legítimo (`http://localhost:5173`) → 201, sigue
funcionando. `GET /resultados` (solo lectura) no está cubierto por este
middleware — comportamiento heredado y ya aceptado (`sameSite: Lax` en
dev/`none` en prod alcanza para métodos de solo lectura, el riesgo real
de CSRF es en las mutaciones). Sin hallazgos nuevos.

## 10. SSRF

No aplica — ninguna de las 3 services del módulo hace una llamada HTTP
saliente ni acepta una URL como input.

## 11. Path traversal

No aplica — ninguna operación de filesystem en este módulo (sin
upload/lectura de archivos, a diferencia de `products` con
`CatalogImportController`).

## 12. Sensitive information exposure

Mensajes de error confirmados genéricos (sección 6, más los ya
verbatim contra la spec en la Fase 07) — sin nombres de columna, sin
stack traces, sin detalles de Prisma expuestos al cliente en ningún
código de error probado (404/400/403/409). `costoUnitario` (visible en
`rankingProductos`, dato sensible de margen) solo llega a rutas
`OWNER`-only — no hay ningún camino donde un `SELLER` lo reciba desde
este módulo (a diferencia de `sales`, que sí tiene que ocultarlo
selectivamente porque comparte endpoint con `SELLER`). Sin hallazgos.

## 13. Secrets

`grep` de credenciales/tokens hardcodeados en `src/modules/expenses/`:
sin resultados. Las 4 `Setting` reales (sección 2.1 más abajo) son
config de negocio (booleanos/enteros/decimales), nunca secretos —
`SettingsService.setValor` ni siquiera acepta un tipo de dato libre
(`STRING`) que pudiera usarse para guardar una contraseña o clave por
error. Sin hallazgos.

## 14. Logs

Sin logging propio en el módulo (`grep` de `console.log`/`Logger` en
`src/modules/expenses/`: sin resultados) — depende enteramente del
logger HTTP global (`pino`), que ya redacta `cookie` (confirmado
`"cookie":"[REDACTED]"` en los logs reales de esta misma sesión de
auditoría). El body de los requests de este módulo (`monto`,
`descripcion`, `valor` de un setting) sí queda en el log de acceso —
mismo criterio que el resto del sistema (`sales`/`returns` loggean
`total`/`montoTotal` igual), no es información más sensible que eso, y
es un sistema interno de una sola tienda, no un log público. Sin
hallazgo nuevo.

## 15. Error handling

Confirmado que ningún error de este módulo devuelve 500 para un input
de usuario inválido — la Fase 08 corrigió justamente el caso que
hubiera dado 500 (formato de fecha inválido tirando un `Error` común
sin capturar, ver su reporte sección 2.1). Recorridos EN VIVO en esta
fase: 400 (validación), 401 (sin sesión), 403 (rol/origen), 404
(recurso/clave inexistente), 409 (categoría bloqueada/nombre duplicado,
ya cubierto en Fase 07/08) — ninguno cae a 500. Sin hallazgos.

## 16. Rate limiting

**Hallazgo LOW, ya esperado — registrado como TD-16** (`state/TECH_DEBT.md`):
`POST /expenses`, `POST`/`PATCH /expense-categories` y
`PATCH /settings/:clave` no tienen `@nestjs/throttler` — mismo patrón
exacto que TD-12 (`cash-registers`)/TD-14 (`sales`)/TD-15 (`returns`).
No bloquea: todas exigen sesión autenticada (`OWNER`-only para
`expenses`/`settings`), y es la misma decisión transversal ya tomada
para el resto del sistema — el único endpoint con rate limiting sigue
siendo `/auth/login` (confirmado EN VIVO: la respuesta de login trae
`X-RateLimit-Limit-login: 20`).

## 17. Dependencies

`npm audit --omit=dev`: **3 high**, exactamente la misma cadena de
`prisma` CLI (`@prisma/config` → `deepmerge-ts`) ya documentada y
aceptada en TD-9 — sin cambios desde la última auditoría. `npm audit`
completo: 12 advisories (5 low, 3 moderate, 4 high), mismo total exacto
que TD-9 — la cadena de Stryker (devDependency, nunca se empaqueta) no
agregó nada nuevo desde la Fase 08 de este módulo. Sin hallazgo nuevo.

## 18. Sensitive data storage

`Expense.descripcion` es texto libre ingresado por el `OWNER` — sin cifrado
en reposo, mismo criterio que el resto de las columnas de texto del
sistema (`sales.descripcion`, etc., ninguna cifrada). No es PII de
terceros ni un dato regulado (tarjetas, salud) — gasto operativo de la
tienda. `Setting.valor` nunca puede ser un secreto (sección 13). Sin
hallazgos.

## 19. Incorrect permissions

Cubierto en las secciones 2/3 — `@Roles(OWNER)` presente en las 7 rutas
que corresponde (`expenses` ×2, `resultados` ×3, `settings` ×2),
ausente deliberadamente en las 3 de `expense-categories`. Confirmado
EN VIVO contra el código real, no solo leído. Sin discrepancias.

## 20. Unauthorized endpoints

Log de arranque del servidor real (`RouterExplorer`) confirma
exactamente las rutas esperadas y ninguna de más:
`{GET,POST} /expense-categories`, `PATCH /expense-categories/:id`,
`{POST,GET} /expenses`, `GET /resultados`,
`GET /resultados/ranking-productos`, `GET /resultados/gastos-por-categoria`,
`GET /settings`, `PATCH /settings/:clave`. Sin `DELETE` en ningún lado
(RN-1, ya confirmado en Fase 07) y sin ninguna ruta de debug/test
colada en el módulo. Sin hallazgos.

## Resumen

| # | Categoría | Resultado |
|---|---|---|
| 1-5, 11-15, 17-20 | — | Sin hallazgos |
| 6, 9 | Input validation, CSRF | Reconfirmados EN VIVO (protecciones ya existentes de la Fase 08/10 de `sales`), sin hallazgos nuevos |
| 16 | Rate limiting | 1 LOW ya esperado — TD-16 |

**Sin CRITICAL, sin HIGH, sin MEDIUM.** El único hallazgo (LOW,
rate limiting) es el mismo patrón transversal ya aceptado 3 veces antes
en el sistema — no bloquea el Quality Gate.

## Verificación

- 514/514 unitarios, 436/436 integración — sin cambios desde la Fase 08
  (esta fase no tocó código).
- `npm audit`/`npm audit --omit=dev` — sin cambios desde TD-9.
- Servidor real levantado, todas las rutas del módulo probadas EN VIVO
  con sesiones reales (`OWNER` seedeado, `SELLER` creado y desactivado
  al terminar) — no solo lectura de código.
- `backend/.env.example` no tocado.

## Problemas pendientes

Ninguno que bloquee. Sigue la Fase 10 (security remediation) — sin
CRITICAL/HIGH que remediar, se espera un resultado similar al de
`returns` (VERDE sin cambios de código, con la constancia explícita).
